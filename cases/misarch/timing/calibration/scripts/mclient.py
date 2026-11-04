"""Minimal async client for MiSArch (Keycloak + GraphQL gateway + Dapr publish), used by seed.py and loadgen.py.

Endpoints (host side of calibration/compose/docker-compose.yaml):
  gateway   http://localhost:8080/graphql
  keycloak  http://localhost:8081/keycloak   (realm Misarch, client "frontend", password grant -- same as Gatling)
  user-dapr http://localhost:3510             (Dapr HTTP API of the user sidecar; used to publish user/user/create
                                               exactly like testdata/create-gatling-user.sh does)
"""
import asyncio
import json
import time

import aiohttp

GATEWAY = "http://localhost:8080/graphql"
KEYCLOAK = "http://localhost:8081/keycloak"
REALM = "Misarch"
USER_DAPR = "http://localhost:3510"


class GqlError(Exception):
    pass


def new_session(limit=200, timeout=120):
    conn = aiohttp.TCPConnector(limit=limit, limit_per_host=limit, force_close=False, ttl_dns_cache=300)
    return aiohttp.ClientSession(connector=conn, timeout=aiohttp.ClientTimeout(total=timeout))


async def user_token(session, username, password="123"):
    """Keycloak password grant, identical to Gatling's 'Get Access Token' request."""
    data = {"client_id": "frontend", "grant_type": "password", "username": username, "password": password}
    async with session.post(f"{KEYCLOAK}/realms/{REALM}/protocol/openid-connect/token", data=data) as r:
        body = await r.json(content_type=None)
        if r.status != 200 or "access_token" not in body:
            raise GqlError(f"token for {username}: {r.status} {body}")
        return body["access_token"]


async def admin_token(session):
    data = {"client_id": "admin-cli", "grant_type": "password", "username": "admin", "password": "admin"}
    async with session.post(f"{KEYCLOAK}/realms/master/protocol/openid-connect/token", data=data) as r:
        return (await r.json(content_type=None))["access_token"]


async def kc_create_user(session, atok, username, first, last, password="123", roles=("buyer",)):
    """Create a Keycloak user with password and realm roles (as testdata/create-gatling-user.sh). Returns its id."""
    h = {"Authorization": f"Bearer {atok}"}
    payload = {"username": username, "firstName": first, "lastName": last, "enabled": True,
               "email": f"{username}@example.org", "emailVerified": True,
               "credentials": [{"type": "password", "value": password, "temporary": False}]}
    async with session.post(f"{KEYCLOAK}/admin/realms/{REALM}/users", json=payload, headers=h) as r:
        if r.status not in (201, 409):
            raise GqlError(f"kc create {username}: {r.status} {await r.text()}")
    async with session.get(f"{KEYCLOAK}/admin/realms/{REALM}/users", params={"username": username, "exact": "true"},
                           headers=h) as r:
        uid = (await r.json())[0]["id"]
    role_objs = []
    for rn in roles:
        async with session.get(f"{KEYCLOAK}/admin/realms/{REALM}/roles/{rn}", headers=h) as r:
            role_objs.append(await r.json())
    async with session.post(f"{KEYCLOAK}/admin/realms/{REALM}/users/{uid}/role-mappings/realm", json=role_objs,
                            headers=h) as r:
        if r.status not in (204, 200):
            raise GqlError(f"kc roles {username}: {r.status} {await r.text()}")
    return uid


async def publish(session, topic, data, pubsub="pubsub"):
    async with session.post(f"{USER_DAPR}/v1.0/publish/{pubsub}/{topic}", json=data) as r:
        if r.status not in (200, 204):
            raise GqlError(f"publish {topic}: {r.status} {await r.text()}")


async def gql(session, query, variables=None, token=None, raise_errors=True):
    """POST a GraphQL request to the gateway. Returns (data, errors, http_status, latency_s)."""
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    body = {"query": query}
    if variables is not None:
        body["variables"] = variables
    t0 = time.perf_counter()
    async with session.post(GATEWAY, data=json.dumps(body), headers=h) as r:
        raw = await r.read()
        lat = time.perf_counter() - t0
        status = r.status
    try:
        js = json.loads(raw)
    except Exception:
        js = {"errors": [{"message": f"non-json response: {raw[:200]!r}"}]}
    data, errors = js.get("data"), js.get("errors")
    if raise_errors and (errors or status != 200):
        raise GqlError(f"HTTP {status}: {json.dumps(errors)[:600]}")
    return data, errors, status, lat


async def gather_limited(n, coros):
    sem = asyncio.Semaphore(n)

    async def run(c):
        async with sem:
            return await c

    return await asyncio.gather(*(run(c) for c in coros))
