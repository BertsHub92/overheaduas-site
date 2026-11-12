#!/usr/bin/env python3
"""Build the encrypted Pilot Portal for overheaduas.com.

Forms are encrypted with a fresh random key on every build. That key is then
locked separately with each pilot's personal code, so:
  * each pilot has their own code,
  * removing a code and rebuilding cuts that pilot off (the key changes),
  * nothing readable (forms, names, codes) is ever committed to the repo.

Usage (run from the repo root):
  python3 tools/build_portal.py CONFIG.json

CONFIG.json (keep it OUT of the repo; it contains the codes):
{
  "unlock_with": "an existing valid code (only needed to keep current forms)",
  "codes": {"Bert": "....", "Anthony": "....", "Mike": "...."},
  "forms": [
    {"keep": "O105 Service Agreement"},                         # keep an existing form by title
    {"title": "...", "desc": "...", "file": "/path/to/new.pdf"} # add a new form
  ]
}
Any existing form not listed is removed. Codes not listed lose access.
"""
import base64, json, os, re, secrets, sys, datetime
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

OUT = 'portal'
ITER = 600_000
b64 = lambda b: base64.b64encode(b).decode()
unb64 = base64.b64decode

def norm(code):
    return re.sub(r'[^a-z0-9]', '', code.lower())

def kek(code, salt, it):
    return PBKDF2HMAC(hashes.SHA256(), 32, salt, it).derive(norm(code).encode())

def seal(key, data, aad):
    iv = secrets.token_bytes(12)
    return iv + AESGCM(key).encrypt(iv, data, aad)

def unseal(key, blob, aad):
    return AESGCM(key).decrypt(blob[:12], blob[12:], aad)

def load_existing(code):
    keys = json.load(open(f'{OUT}/keys.json'))
    k = kek(code, unb64(keys['salt']), keys['iter'])
    for s in keys['slots']:
        try:
            K = AESGCM(k).decrypt(unb64(s['i']), unb64(s['k']), b'slot'); break
        except Exception:
            continue
    else:
        sys.exit('unlock_with code did not match any current pilot code')
    man = json.loads(unseal(K, open(f'{OUT}/manifest.bin', 'rb').read(), b'manifest'))
    forms = {}
    for f in man['forms']:
        data = unseal(K, open(f"{OUT}/{f['id']}.bin", 'rb').read(), f['id'].encode())
        forms[f['title']] = dict(f, data=data)
    return forms

def main(cfg_path):
    cfg = json.load(open(cfg_path))
    codes = cfg['codes']
    if len({norm(c) for c in codes.values()}) != len(codes):
        sys.exit('two pilots have the same code')
    if any(len(norm(c)) < 16 for c in codes.values()):
        sys.exit('codes must be long (16+ letters/digits)')
    existing = load_existing(cfg['unlock_with']) if os.path.exists(f'{OUT}/keys.json') and cfg.get('unlock_with') else {}

    forms = []
    for f in cfg['forms']:
        if 'keep' in f:
            if f['keep'] not in existing: sys.exit(f"no existing form titled {f['keep']!r}")
            e = existing[f['keep']]
            forms.append(dict(title=e['title'], desc=e.get('desc', ''), filename=e['filename'], type=e['type'], data=e['data']))
        else:
            data = open(f['file'], 'rb').read()
            forms.append(dict(title=f['title'], desc=f.get('desc', ''), filename=f.get('filename', os.path.basename(f['file'])),
                              type=f.get('type', 'application/pdf'), data=data))

    # fresh content key + fresh output every build
    K = AESGCM.generate_key(256)
    os.makedirs(OUT, exist_ok=True)
    for name in os.listdir(OUT):
        os.remove(os.path.join(OUT, name))
    manifest = {'updated': datetime.date.today().isoformat(), 'forms': []}
    for f in forms:
        fid = 'f-' + secrets.token_hex(8)
        open(f'{OUT}/{fid}.bin', 'wb').write(seal(K, f['data'], fid.encode()))
        manifest['forms'].append(dict(id=fid, title=f['title'], desc=f['desc'], filename=f['filename'], type=f['type'], size=len(f['data'])))
    open(f'{OUT}/manifest.bin', 'wb').write(seal(K, json.dumps(manifest).encode(), b'manifest'))

    salt = secrets.token_bytes(16)
    slots = []
    for code in codes.values():
        iv = secrets.token_bytes(12)
        slots.append({'i': b64(iv), 'k': b64(AESGCM(kek(code, salt, ITER)).encrypt(iv, K, b'slot'))})
    secrets.SystemRandom().shuffle(slots)
    json.dump({'v': 1, 'iter': ITER, 'salt': b64(salt), 'slots': slots}, open(f'{OUT}/keys.json', 'w'))
    print(f"built {len(forms)} form(s) for {len(codes)} pilot code(s): {', '.join(codes)}")

if __name__ == '__main__':
    main(sys.argv[1])
