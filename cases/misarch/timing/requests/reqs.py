"""Request catalogue of the timing campaign: the 36 request types of workload/sessions.json, two anonymous
variants, and the order-path factorial (README.md §3.5, §3.6).

Texts: round-2 types use loadgen.py's texts unchanged (Gatling's where Gatling has the request). For the other
types the text is the MiSArch frontend's document where the frontend has one (misarch/frontend/src/graphql/*.graphql),
else seed.py's (the calibration seeder), else a minimal selection written here ("A").

Each entry: role (anonymous | buyer | employee), pre (preconditions / pools), src (where the text comes from),
kind (loadgen = executed by loadgen.py's own code in isolation; ext = executed by ext.py), text.
"""
import os
import sys

CAL_SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "calibration", "scripts")
os.environ.setdefault("MISARCH_STACK", "kotlin")
if CAL_SCRIPTS not in sys.path:
    sys.path.insert(0, CAL_SCRIPTS)
import loadgen as L  # noqa: E402  (read-only reuse: texts, Gen, run_plan)

# --- anonymous variants of the two browse requests: Product.internalName needs an employee (catalog spec §5), so an
# anonymous client sends Gatling's text without that field
Q_PRODUCTS_ANON = L.Q_PRODUCTS.replace(" internalName", "")
Q_PRODUCT_ANON = L.Q_PRODUCT.replace(" internalName", "")
# cart line with a count: Gatling's text with `count: %d`; args (userId, count, variantId)
Q_CART_N = L.Q_CART.replace("count: 1", "count: %d")

Q_NOTIFICATIONS = ('query getNotificationsOfCurrentUser { currentUser { id notifications(first: 10) { totalCount '
                   'hasNextPage nodes { id title body isRead dateSent } } } }')
Q_CREATE_USER_ADDRESS = 'mutation createUserAddress($input: CreateUserAddressInput!) { createUserAddress(input: $input) { id } }'
Q_CREATE_VENDOR_ADDRESS = 'mutation($i: CreateVendorAddressInput!) { createVendorAddress(input: $i) { id } }'
Q_CREATE_CATEGORY = 'mutation createCategory($input: CreateCategoryInput!) { createCategory(input: $input) { id } }'
Q_UPDATE_VARIANT = ('mutation($i: UpdateProductVariantInput!) { updateProductVariant(input: $i) { id isPubliclyVisible } }')
Q_CREATE_COUPON = 'mutation($i: CreateCouponInput!) { createCoupon(input: $i) { id } }'
Q_CREATE_DISCOUNT = 'mutation($i: CreateDiscountInput!) { createDiscount(input: $i) { id } }'
Q_REGISTER_COUPON = 'mutation($i: RegisterCouponInput!) { registerCoupon(input: $i) { id code } }'
Q_ITEM_BATCH = ('mutation createProductItemBatch($input: CreateProductItemBatchInput!) { '
                'createProductItemBatch(input: $input) { id inventoryStatus } }')
Q_UPLOAD_MEDIA = 'mutation($file: Upload!) { uploadMedia(mediaFile: $file) }'
Q_CREATE_CC = ('mutation createCreditCardPaymentInformation($input: CreateCreditCardInformationInput!) { '
               'createCreditCardPaymentInformation(input: $input) { id } }')
Q_CREATE_RETURN = 'mutation($i: CreateReturnInput!) { createReturn(input: $i) { id refundedAmount } }'
Q_CREATE_SHIPMENT_METHOD = 'mutation($i: CreateShipmentMethodInput!) { createShipmentMethod(input: $i) { id } }'
Q_CREATE_TAX_RATE = 'mutation createTaxRate($input: CreateTaxRateInput!) { createTaxRate(input: $input) { id } }'
Q_CREATE_TAX_RATE_VERSION = ('mutation createTaxRateVersion($input: CreateTaxRateVersionInput!) { '
                             'createTaxRateVersion(input: $input) { id } }')
Q_UPDATE_USER = 'mutation($i: UpdateUserInput!) { updateUser(input: $i) { id } }'
Q_CREATE_WISHLIST = ('mutation addWishlist($input: CreateWishlistInput!) { createWishlist(input: $input) { ...wishlist } } '
                     'fragment wishlist on Wishlist { id name createdAt lastUpdatedAt productVariants { totalCount } }')
# helpers (setup / cleanup only, never inside a measured phase)
Q_DELETE_CART_ITEM = 'mutation($id: UUID!) { deleteShoppingcartItem(id: $id) }'
Q_ARCHIVE_SHIPMENT_METHOD = 'mutation($i: ArchiveShipmentMethodInput!) { archiveShipmentMethod(input: $i) { id } }'
Q_ORDER_ITEMS = ('query($id: UUID!) { order(id: $id) { id orderStatus orderItems { nodes { id } } '
                 'shipments { nodes { id status } } } }')

F = "frontend (misarch/frontend/src/graphql)"
S = "seed.py (calibration seeder)"
G = "Gatling (loadgen.py, verbatim)"
LG = "loadgen.py (round 2)"
A = "A (written here, minimal selection)"

# role, preconditions, source, kind, text. `pre` names the pools / data a request needs.
REQUESTS = {
    # ---- round-2 documents (A's `requests`): loadgen executes them in isolation exactly as in round 2
    "login": dict(role="buyer", pre="a seeded buyer (password 123)", src="Gatling 'Get Access Token' (loadgen type token)",
                  kind="loadgen", lg="token", text="POST keycloak/realms/Misarch/protocol/openid-connect/token (password grant)"),
    "products": dict(role="buyer*", pre="-", src=G, kind="loadgen", text=L.Q_PRODUCTS),
    "product": dict(role="buyer*", pre="seeded products", src=G, kind="loadgen", text=L.Q_PRODUCT),
    "users": dict(role="buyer", pre="-", src=G, kind="loadgen", text=L.Q_USER),
    "address": dict(role="buyer", pre="buyer with an address", src=G, kind="loadgen", text=L.Q_ADDRESS),
    "createShoppingcartItem": dict(role="buyer", pre="seeded variants", src=G, kind="loadgen", text=L.Q_CART),
    "shipmentMethods": dict(role="buyer", pre="seeded shipment methods", src=G, kind="loadgen", text=L.Q_SHIPMENT_METHODS),
    "paymentInformations": dict(role="buyer", pre="-", src=G, kind="loadgen", text=L.Q_PAYMENT_INFOS),
    "createOrder": dict(role="buyer", pre="cart pool (createShoppingcartItem earlier in the window)", src=G, kind="loadgen",
                        text=L.Q_CREATE_ORDER),
    "placeOrder": dict(role="buyer", pre="created-order pool (createOrder < 50 min ago)", src=G, kind="loadgen",
                       text=L.Q_PLACE_ORDER),
    "orderTracking": dict(role="buyer", pre="placed-order pool", src=LG, kind="loadgen", text=L.Q_ORDER_TRACKING),
    "wishlistView": dict(role="buyer", pre="buyer with a wishlist", src=LG, kind="loadgen", text=L.Q_WISHLIST_VIEW),
    "addToWishlist": dict(role="buyer", pre="buyer with a wishlist", src=LG, kind="loadgen", text=L.Q_WISHLIST_ADD),
    "createReview": dict(role="buyer", pre="(buyer, variant) not yet reviewed (reviewed pool)", src=LG, kind="loadgen",
                         text=L.Q_REVIEW),
    "adminUpdateProduct": dict(role="employee", pre="seeded products", src=LG, kind="loadgen", text=L.Q_ADMIN_UPDATE_PRODUCT),
    "adminNewPrice": dict(role="employee", pre="seeded variants", src=LG, kind="loadgen", text=L.Q_ADMIN_NEW_PRICE),
    "adminCreateVariant": dict(role="employee", pre="seeded products", src=LG, kind="loadgen", text=L.Q_ADMIN_CREATE_VARIANT),
    "adminCreateProduct": dict(role="employee", pre="seeded categories", src=LG, kind="loadgen", text=L.Q_ADMIN_CREATE_PRODUCT),
    # ---- the 19 requests without a round-2 document
    "notifications": dict(role="buyer", pre="-", src=A + "; plan by analogy with address", kind="ext", text=Q_NOTIFICATIONS),
    "registration": dict(role="anonymous", pre="master-realm admin-cli token (fetched and cached by ext.py)",
                         src="Keycloak admin REST POST /admin/realms/Misarch/users (stand-in for the registration form); "
                             "Keycloak publishes user/user/create", kind="ext",
                         text="POST keycloak/admin/realms/Misarch/users {username, firstName, lastName, email, credentials}"),
    "address.createUserAddress": dict(role="buyer", pre="-", src=F, kind="ext", text=Q_CREATE_USER_ADDRESS),
    "address.createVendorAddress": dict(role="employee", pre="-", src=S, kind="ext", text=Q_CREATE_VENDOR_ADDRESS),
    "catalog.createCategory": dict(role="employee", pre="-", src=F, kind="ext", text=Q_CREATE_CATEGORY),
    "catalog.updateProductVariant": dict(role="employee", pre="seeded variants (stay public)", src=A, kind="ext",
                                         text=Q_UPDATE_VARIANT),
    "discount.createCoupon": dict(role="employee", pre="sink discount (setup)", src=S, kind="ext", text=Q_CREATE_COUPON),
    "discount.createDiscount": dict(role="employee", pre="sink category (setup): new discounts never apply to orders",
                                    src=S, kind="ext", text=Q_CREATE_DISCOUNT),
    "discount.registerCoupon": dict(role="buyer", pre="registration coupons (setup) x users not yet registered (pool)",
                                    src=A, kind="ext", text=Q_REGISTER_COUPON),
    "inventory.createProductItemBatch": dict(role="employee", pre="seeded variants; number = 20 items per batch",
                                             src=F, kind="ext", text=Q_ITEM_BATCH),
    "media.uploadMedia": dict(role="employee", pre="-; multipart upload (GraphQL multipart spec) of a 1 KB PNG",
                              src=A, kind="ext", text=Q_UPLOAD_MEDIA),
    "payment.createCreditCardPaymentInformation": dict(role="buyer", pre="-", src=F, kind="ext", text=Q_CREATE_CC),
    "return.createReturn": dict(role="buyer", pre="returnable pool (delivered, not returned, within the return period; "
                                                  "run.py prep)", src=A, kind="ext", text=Q_CREATE_RETURN),
    "shipment.createShipmentMethod": dict(role="employee", pre="-; created methods are archived by run.py cleanup",
                                          src=S, kind="ext", text=Q_CREATE_SHIPMENT_METHOD),
    "tax.createTaxRate": dict(role="employee", pre="-", src=F, kind="ext", text=Q_CREATE_TAX_RATE),
    "tax.createTaxRateVersion": dict(role="employee", pre="seeded tax rates (same rate again, prices unchanged)", src=F,
                                     kind="ext", text=Q_CREATE_TAX_RATE_VERSION),
    "user.updateUser": dict(role="buyer", pre="-", src=A, kind="ext", text=Q_UPDATE_USER),
    "wishlist.createWishlist": dict(role="buyer", pre="seeded variants", src=F, kind="ext", text=Q_CREATE_WISHLIST),
    # ---- anonymous variants (sessions: browser class and pages before the login)
    "products.anon": dict(role="anonymous", pre="-", src=G + " without internalName", kind="ext", text=Q_PRODUCTS_ANON),
    "product.anon": dict(role="anonymous", pre="seeded products", src=G + " without internalName", kind="ext",
                         text=Q_PRODUCT_ANON),
}
# ---- block 6 (mechanisms: local copies, response caches; README.md §4.1). Not session types, so not in REQUESTS (the
# other blocks' plans iterate REQUESTS). `base` is the session request type whose text and operations they use.
Q_UPDATE_DISCOUNT = 'mutation($i: UpdateDiscountInput!) { updateDiscount(input: $i) { id } }'
MECH_REQUESTS = {
    # response cache, controlled key sets: hot = a few keys repeated within the TTL (all hits after the first),
    # cold = every request a key not used before in the window (all misses)
    "orderTracking.hot": dict(role="buyer", base="orderTracking", pre="placed-order pool; 4 (buyer, order) keys",
                              src=LG, kind="ext", text=L.Q_ORDER_TRACKING),
    "orderTracking.cold": dict(role="buyer", base="orderTracking", pre="placed-order pool; each order once per window",
                               src=LG, kind="ext", text=L.Q_ORDER_TRACKING),
    "wishlistView.hot": dict(role="buyer", base="wishlistView", pre="wishlists; 4 (buyer, wishlist) keys", src=LG,
                             kind="ext", text=L.Q_WISHLIST_VIEW),
    "wishlistView.cold": dict(role="buyer", base="wishlistView", pre="wishlists; each wishlist once per window", src=LG,
                              kind="ext", text=L.Q_WISHLIST_VIEW),
    # caller-side cache of order's sync invocations (README.md §4.1): hot = createOrder with one of 4 fixed
    # (buyer, cart line, shipment method) triples, repeated within the TTL (the request bodies to shipment, discount and
    # inventory repeat: all hits after the first); cold = loadgen's createOrder after a cart fill (fresh lines)
    "createOrder.hot": dict(role="buyer", base="createOrder", pre="4 cart lines created at first use (never placed)",
                            src=G, kind="ext", text=L.Q_CREATE_ORDER),
    # copy-writing events without a request type of their own: discount/discount/updated, shipment-method/archived
    "discount.updateDiscount": dict(role="employee", base=None, pre="sink discount (setup): validUntil renewed",
                                    src=A, kind="ext", text=Q_UPDATE_DISCOUNT),
    "shipment.archiveShipmentMethod": dict(role="employee", base=None,
                                           pre="methods created by shipment.createShipmentMethod (pool)", src=S,
                                           kind="ext", text=Q_ARCHIVE_SHIPMENT_METHOD),
}

SESSION_TYPES = [k for k in REQUESTS if not k.endswith(".anon")]   # the 36 of workload/sessions.json
ANON = {"products": "products.anon", "product": "product.anon"}

# ---- order-path factorial (§3.6): items x quantity x coupon x payment method, stock 60 / 600
ITEMS = (1, 3)
QUANTITY = (1, 3)
COUPON = (0, 1)
PAYMENT = {"INV": "INVOICE", "PRE": "PREPAYMENT", "CC": "CREDIT_CARD"}
STOCK = (60, 600)


def cell_id(items, qty, coupon, pay, stock=60):
    return f"i{items}q{qty}c{coupon}{pay}s{stock}"


def parse_cell(cell):
    import re
    m = re.fullmatch(r"i(\d+)q(\d+)c([01])(INV|PRE|CC)s(\d+)", cell)
    if not m:
        raise ValueError(cell)
    return dict(items=int(m[1]), qty=int(m[2]), coupon=int(m[3]), pay=m[4], method=PAYMENT[m[4]], stock=int(m[5]))


def factorial_cells(stock=60):
    return [cell_id(i, q, c, p, stock) for i in ITEMS for q in QUANTITY for c in COUPON for p in PAYMENT]


# request types of one cell: foCart (fill, not measured), foOrder (createOrder), foPlace (placeOrder + saga)
FO_KINDS = ("foCart", "foOrder", "foPlace")
