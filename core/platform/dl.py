# downloads optimisation executions like dl.mjs, but with plain HTTP (no Chrome): the session cookie comes
# from build/platform/state.json (log in once with any .mjs tool). Skips solution files already present.
# usage: BASE=... python3 dl.py <execution id prefix>...   writes build/platform/executions/<config>-<id prefix>/
import json, os, sys, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get('BASE', 'http://localhost:4242')
PID = os.environ.get('PID') or json.load(open(os.path.join(HERE, '..', '..', 'cases', os.environ.get('ARCH_CASE', 'misarch'), 'platform.json')))['projectId']
OUT = os.environ.get('OUT') or os.path.join(HERE, '../../build/platform/executions')
state = json.load(open(os.path.join(HERE, '../../build/platform/state.json')))
COOKIE = '; '.join(f"{c['name']}={c['value']}" for c in state['cookies'])
P = f'/api/projects/{PID}/executions'


def get(path):
    req = urllib.request.Request(BASE + path, headers={'Cookie': COOKIE})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b''


s, body = get(P)
if s != 200:
    sys.exit(f'list failed: {s} (session expired? run any .mjs tool once)')
lst = json.loads(body)
lst = lst if isinstance(lst, list) else lst['items']
for e in lst:
    if not e['filePath'].endswith('.config') or not any(e['id'].startswith(i) for i in sys.argv[1:]):
        continue
    name = e['filePath'].split('/')[-1][:-len('.config')] + '-' + e['id'][:8]
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'execution.json'), 'wb').write(get(f"{P}/{e['id']}")[1])
    s, summ = get(f"{P}/{e['id']}/summary")
    open(os.path.join(d, 'summary.json'), 'wb').write(summ)
    try:
        open(os.path.join(d, 'summary.md'), 'w').write(json.loads(summ)['summary'])
    except Exception:
        pass
    n = missing = 0
    s, top = get(f"{P}/{e['id']}/files/report.json")
    for b in range(1, 4):
        if s == 200:
            if b > 1:
                break
            rep = top
        else:
            rs, rep = get(f"{P}/{e['id']}/files/batch_{b}/report.json")
            if rs != 200:
                break
        bd = os.path.join(d, f'batch_{b}')
        os.makedirs(bd, exist_ok=True)
        open(os.path.join(bd, 'report.json'), 'wb').write(rep)
        for sol in json.loads(rep)['paretoFront']:
            f = os.path.join(bd, sol['path'].split('/')[-1])
            if os.path.exists(f) and os.path.getsize(f) > 0:
                n += 1
                continue
            fs, data = get(f"{P}/{e['id']}/files/{sol['path']}")
            if fs != 200:
                print('missing', sol['path'], fs)
                missing += 1
                continue
            open(f, 'wb').write(data)
            n += 1
    print(name, e['id'], e['state'], 'solutions', n, 'missing', missing, flush=True)
