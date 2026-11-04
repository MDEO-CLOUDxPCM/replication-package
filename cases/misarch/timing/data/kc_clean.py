#!/usr/bin/env python3
"""Delete every Keycloak user of realm Misarch except the load generators' session pool (gatling, buyer*, fbuyer*).

    kc_clean.py [--dry-run]      (calibration venv; Keycloak at localhost:8081)
"""
import asyncio
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "calibration", "scripts"))
import mclient  # noqa: E402

KEEP = re.compile(r"^(gatling|buyer\d{4}|fbuyer\d{4})$")


async def main(dry):
    async with mclient.new_session(limit=16) as s:
        tok = await mclient.admin_token(s)
        h = {"Authorization": f"Bearer {tok}"}
        users, first = [], 0
        while True:
            async with s.get(f"{mclient.KEYCLOAK}/admin/realms/{mclient.REALM}/users",
                             params={"first": first, "max": 500, "briefRepresentation": "true"}, headers=h) as r:
                page = await r.json()
            users += page
            if len(page) < 500:
                break
            first += 500
        drop = [u for u in users if not KEEP.match(u["username"])]
        print(f"{len(users)} users, keep {len(users) - len(drop)}, delete {len(drop)}", flush=True)
        if dry:
            return
        sem = asyncio.Semaphore(8)

        async def rm(u):
            async with sem:
                async with s.delete(f"{mclient.KEYCLOAK}/admin/realms/{mclient.REALM}/users/{u['id']}", headers=h) as r:
                    if r.status not in (204, 404):
                        raise RuntimeError(f"{u['username']}: {r.status}")
        await asyncio.gather(*(rm(u) for u in drop))
        print("deleted", len(drop))

asyncio.run(main("--dry-run" in sys.argv))
