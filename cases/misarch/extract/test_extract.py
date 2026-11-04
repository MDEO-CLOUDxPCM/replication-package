#!/usr/bin/env python3
"""Tests of the schema reader (sql_schema.py: forward migrations) and of the entity -> table mapping of the
persistence inventory (persistence.py: `@Table`), on synthetic sources. `python3 -m unittest test_extract` in this
directory (no misarch-kotlin needed)."""
import contextlib
import unittest
from unittest import mock

import gitsrc
import kt
import persistence
import sql_schema
from sql_schema import SchemaError

V1 = """
CREATE TABLE ProductEntity (id UUID PRIMARY KEY, name VARCHAR(255) NOT NULL);
CREATE TABLE CategoryEntity (id UUID PRIMARY KEY, name VARCHAR(255));
CREATE TABLE ProductToCategoryEntity (
    id UUID PRIMARY KEY,
    productId UUID REFERENCES ProductEntity(id),
    categoryId UUID,
    FOREIGN KEY (categoryId) REFERENCES CategoryEntity(id),
    UNIQUE (productId, categoryId)
);
CREATE INDEX productToCategoryEntity_categoryId ON ProductToCategoryEntity (categoryId);
"""


def schema(*sources):
    return sql_schema.apply("svc", [(f"V{i + 1}__m.sql", s) for i, s in enumerate(sources)])


class Schema(unittest.TestCase):
    def test_create(self):
        tables, _ = schema(V1)
        t = tables["producttocategoryentity"]
        self.assertEqual(sorted(t["columns"]), ["categoryId", "id", "productId"])
        self.assertEqual(t["primaryKey"], ["id"])
        self.assertEqual(t["unique"], [["productId", "categoryId"]])
        self.assertEqual({(f["column"], f["references"]) for f in t["foreignKeys"]},
                         {("productId", "ProductEntity"), ("categoryId", "CategoryEntity")})
        self.assertEqual(t["evidence"], "V1__m.sql:4")

    def test_link_table_composite_key(self):
        tables, _ = schema(V1, """
            ALTER TABLE ProductToCategoryEntity DROP COLUMN id;
            ALTER TABLE ProductToCategoryEntity DROP CONSTRAINT producttocategoryentity_productid_categoryid_key,
                ADD PRIMARY KEY (productId, categoryId);
            ALTER TABLE ProductToCategoryEntity ALTER COLUMN categoryId SET NOT NULL;""")
        t = tables["producttocategoryentity"]
        self.assertEqual(sorted(t["columns"]), ["categoryId", "productId"])
        self.assertEqual(t["primaryKey"], ["productId", "categoryId"])
        self.assertEqual(t["unique"], [])
        self.assertTrue(t["columns"]["categoryId"]["notNull"])

    def test_rename_table_and_columns(self):
        tables, _ = schema(V1, """
            CREATE TABLE reviews (id UUID PRIMARY KEY, product_id UUID REFERENCES ProductEntity(id), "Rating" INT);
            ALTER TABLE reviews RENAME TO ReviewEntity;
            ALTER TABLE ReviewEntity RENAME COLUMN product_id TO productId;
            ALTER TABLE "ReviewEntity" RENAME "Rating" TO rating;
            ALTER TABLE ProductEntity RENAME TO ItemEntity;""")
        self.assertNotIn("reviews", tables)
        t = tables["reviewentity"]
        self.assertEqual(t["table"], "ReviewEntity")
        self.assertEqual(sorted(t["columns"]), ["id", "productId", "rating"])
        self.assertEqual([(f["column"], f["references"]) for f in t["foreignKeys"]], [("productId", "ItemEntity")])
        self.assertIn("itementity", tables)

    def test_multi_action_alter_and_types(self):
        tables, _ = schema(V1, """
            ALTER TABLE public.ProductEntity
                ADD COLUMN price NUMERIC(10, 2) DEFAULT 0,
                ADD COLUMN IF NOT EXISTS name TEXT,
                ALTER COLUMN name TYPE TEXT USING (CASE WHEN name IS NULL THEN 'a, b' ELSE name END),
                ALTER COLUMN price SET DATA TYPE DOUBLE PRECISION,
                ALTER COLUMN price SET DEFAULT 1,
                ALTER COLUMN name DROP NOT NULL;""")
        c = tables["productentity"]["columns"]
        self.assertEqual(c["name"], {"type": "text", "notNull": False})
        self.assertEqual(c["price"]["type"], "double precision")

    def test_drop_column_drops_its_keys_and_indexes(self):
        tables, _ = schema(V1, "ALTER TABLE ProductToCategoryEntity DROP COLUMN categoryId CASCADE;")
        t = tables["producttocategoryentity"]
        self.assertEqual(t["unique"], [])
        self.assertEqual(t["indexes"], [])
        self.assertEqual([f["column"] for f in t["foreignKeys"]], ["productId"])

    def test_named_constraints(self):
        tables, _ = schema(V1, """
            ALTER TABLE ProductEntity ADD COLUMN categoryId UUID;
            ALTER TABLE ProductEntity ADD CONSTRAINT fk_category FOREIGN KEY (categoryId) REFERENCES CategoryEntity (id);
            ALTER TABLE ProductEntity DROP CONSTRAINT fk_category;
            ALTER TABLE ProductEntity DROP CONSTRAINT productentity_pkey;
            ALTER TABLE ProductEntity DROP CONSTRAINT IF EXISTS nothing_here;""")
        t = tables["productentity"]
        self.assertEqual(t["foreignKeys"], [])
        self.assertEqual(t["primaryKey"], [])

    def test_primary_key_using_index(self):
        tables, _ = schema(V1, """
            CREATE UNIQUE INDEX pc_pair ON ProductToCategoryEntity (productId, categoryId);
            ALTER TABLE ProductToCategoryEntity DROP COLUMN id;
            ALTER TABLE ProductToCategoryEntity ADD CONSTRAINT pc_pkey PRIMARY KEY USING INDEX pc_pair;""")
        t = tables["producttocategoryentity"]
        self.assertEqual(t["primaryKey"], ["productId", "categoryId"])
        self.assertEqual([i["name"] for i in t["indexes"]], ["productToCategoryEntity_categoryId"])

    def test_drop_table_and_indexes(self):
        tables, _ = schema(V1, """
            DROP INDEX productToCategoryEntity_categoryId;
            DROP INDEX IF EXISTS gone;
            DROP TABLE IF EXISTS ProductToCategoryEntity, Nope CASCADE;""")
        self.assertEqual(sorted(tables), ["categoryentity", "productentity"])

    def test_do_blocks_and_dml_are_skipped(self):
        tables, _ = schema(V1, """
            DO $$ BEGIN EXECUTE 'ALTER TABLE ProductEntity DROP COLUMN name; '; END $$;
            DELETE FROM ProductToCategoryEntity a USING ProductToCategoryEntity b WHERE a.id > b.id;
            INSERT INTO CategoryEntity (id, name) VALUES (gen_random_uuid(), 'x');""")
        self.assertIn("name", tables["productentity"]["columns"])

    def test_triggers_follow_renames(self):
        _, triggers = schema(V1, """
            CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN UPDATE CategoryEntity SET name = 'x'; RETURN NEW; END $$
                LANGUAGE plpgsql;
            CREATE TRIGGER t AFTER INSERT ON ProductEntity FOR EACH ROW EXECUTE FUNCTION f();
            ALTER TABLE ProductEntity RENAME TO ItemEntity;""")
        self.assertEqual([(t["table"], t["writesTables"]) for t in triggers], [("itementity", ["categoryentity"])])

    def test_errors_are_loud(self):
        for bad in ("ALTER TABLE Missing ADD COLUMN x INT;",
                    "ALTER TABLE ProductEntity DROP COLUMN missing;",
                    "ALTER TABLE ProductEntity RENAME COLUMN missing TO x;",
                    "ALTER TABLE ProductEntity RENAME COLUMN id TO name;",
                    "ALTER TABLE ProductEntity DROP CONSTRAINT missing;",
                    "ALTER TABLE ProductEntity ALTER COLUMN name SET MAGIC;",
                    "ALTER TABLE ProductEntity INHERIT CategoryEntity;",
                    "ALTER TABLE ProductEntity RENAME TO CategoryEntity;",
                    "DROP TABLE Missing;",
                    "DROP INDEX missing;",
                    "CREATE INDEX i ON ProductEntity (missing);"):
            with self.subTest(bad), self.assertRaises(SchemaError):
                schema(V1, bad)


ENTITY = """package org.misarch.svc.persistence.model
/** a doc comment naming @Table("Nope") class Nope */
@Table
class ProductEntity(@Id val id: UUID)

@Table("ProductToCategoryEntity")
data class ProductCategoryLink(@Id val key: ProductCategoryKey) : Persistable<ProductCategoryKey>

class CategoryEntity(@Id val id: UUID)
"""
REPO = """package org.misarch.svc.persistence.repository
interface ProductRepository : CoroutineCrudRepository<ProductEntity, UUID>
interface LinkRepository : CoroutineCrudRepository<ProductCategoryLink, ProductCategoryKey> {
    suspend fun findByKeyProductId(productId: UUID): List<ProductCategoryLink>
}
interface CategoryRepository : CoroutineCrudRepository<CategoryEntity, UUID>
"""
SERVICE = """package org.misarch.svc.service
class ProductService(private val conditionQueries: ConditionQueries) {
    suspend fun find(id: UUID) = conditionQueries.findAll<ProductEntity>(Condition.eq("t.id", id),
        join = "JOIN ProductToCategoryEntity l ON l.productId = t.id")
    suspend fun create() = conditionQueries.insert(ProductEntity(UUID.randomUUID()))
    suspend fun link(product: ProductEntity) {
        val l = ProductCategoryLink(ProductCategoryKey(product.id, product.id))
        conditionQueries.insert(l)
    }
    suspend fun byIds(ids: List<UUID>): List<CategoryEntity> =
        conditionQueries.findAll(Condition.inArray("t.id", ids))
    suspend fun typed(id: UUID) {
        val links: List<ProductCategoryLink> = conditionQueries.findAll(Condition.eq("t.productId", id))
    }
    suspend fun check(ids: Set<UUID>) = existing<ProductEntity>(ids) + existing<CategoryEntity>(ids)
    private suspend inline fun <reified E : Any> existing(ids: Set<UUID>): List<E> =
        conditionQueries.findAll<E>(Condition.inArray("t.id", ids))
}
"""
ROOT = "services/svc/src/main/kotlin/org/misarch/svc/"


@contextlib.contextmanager
def sources(files):
    files = {**files, "services/svc/src/main/resources/db/migration/V1__m.sql": V1}
    caches = [kt.masked, kt.strings, kt.classes, kt.functions, kt.constants, kt.string_exprs,
              persistence.inventory, persistence.entity_tables]
    for c in caches:
        c.cache_clear()
    with mock.patch.object(gitsrc, "files", lambda: tuple(sorted(files))), \
            mock.patch.object(gitsrc, "read", lambda p: files[p]):
        try:
            yield
        finally:
            for c in caches:
                c.cache_clear()


class Entities(unittest.TestCase):
    def inventory(self, **extra):
        files = {ROOT + "persistence/model/Entities.kt": ENTITY, ROOT + "persistence/repository/Repos.kt": REPO,
                 ROOT + "service/ProductService.kt": SERVICE}
        files.update({ROOT + k: v for k, v in extra.items()})
        with sources(files):
            return persistence.inventory("svc")

    def test_table_annotation_names_the_table(self):
        inv = self.inventory()
        self.assertEqual(inv["repositories"], {"ProductRepository": "productentity",
                                               "LinkRepository": "producttocategoryentity",
                                               "CategoryRepository": "categoryentity"})
        m = inv["methods"]
        self.assertEqual(m["LinkRepository.findByKeyProductId"]["reads"], ["producttocategoryentity"])
        self.assertEqual(m["LinkRepository.saveAll"]["writes"], ["producttocategoryentity"])

    def test_condition_queries(self):
        m = self.inventory()["methods"]
        self.assertEqual(m["ProductService.find"]["reads"], ["productentity", "producttocategoryentity"])
        self.assertEqual(m["ProductService.create"]["writes"], ["productentity"])
        self.assertEqual(m["ProductService.link"]["writes"], ["producttocategoryentity"])
        self.assertEqual(m["ProductService.byIds"]["reads"], ["categoryentity"])
        self.assertEqual(m["ProductService.typed"]["reads"], ["producttocategoryentity"])
        self.assertEqual(m["ProductService.existing"]["reads"], ["categoryentity", "productentity"])

    def test_connection_query(self):
        conn = """package org.misarch.svc.graphql.model.connection
class ProductConnection(entityTemplate: R2dbcEntityTemplate) {
    // not a call: entityTemplate.connectionQuery(CategoryEntity::class, ..)
    private val query = entityTemplate.connectionQuery(
        ProductEntity::class, null, listOf("id"), 10, 0
    )
}
class CategoryConnection(private val entityTemplate: R2dbcEntityTemplate) {
    private fun query(): ConnectionQuery<CategoryEntity> = entityTemplate.connectionQuery(
        CategoryEntity::class, null, listOf("id"), 10, 0, join = "JOIN ProductToCategoryEntity j ON j.categoryId = t.id"
    )
}
"""
        m = self.inventory(**{"graphql/model/connection/Connections.kt": conn})["methods"]
        self.assertEqual(m["ProductConnection.query"]["reads"], ["productentity"])
        self.assertEqual(m["CategoryConnection.query"]["reads"], ["categoryentity", "producttocategoryentity"])

    def test_existing_ids_and_nullable_nodes_connection(self):
        svc = """package org.misarch.svc.service
class CheckService(private val conditionQueries: ConditionQueries) {
    suspend fun checkCategories(ids: List<UUID>) {
        val existing = conditionQueries.existingIds<CategoryEntity>(ids)
    }
}
"""
        conn = """package org.misarch.svc.graphql.model.connection
class ProductConnection(
    first: Int?, entityTemplate: R2dbcEntityTemplate,
) : NullableNodesConnection<Product, ProductEntity>(first, entityTemplate, ProductEntity::class, null)
"""
        m = self.inventory(**{"service/CheckService.kt": svc, "graphql/model/connection/ProductConnection.kt": conn})["methods"]
        self.assertEqual(m["CheckService.checkCategories"]["reads"], ["categoryentity"])
        self.assertEqual(m["ProductConnection.nodes"]["reads"], ["productentity"])
        self.assertEqual(m["ProductConnection.totalCount"]["reads"], ["productentity"])

    def test_entity_without_table_is_an_error(self):
        with self.assertRaisesRegex(persistence.PersistenceError, "UserEntity"):
            self.inventory(**{"persistence/repository/UserRepository.kt":
                              "interface UserRepository : CoroutineCrudRepository<UserEntity, UUID>\n"})

    def test_table_annotation_naming_a_missing_table_is_an_error(self):
        with self.assertRaisesRegex(persistence.PersistenceError, "product_to_category"):
            self.inventory(**{"persistence/model/Snake.kt": '@Table("product_to_category")\nclass Snake(val id: UUID)\n'})


if __name__ == "__main__":
    unittest.main()
