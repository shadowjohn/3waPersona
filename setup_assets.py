"""Fetch pinned third-party renderer/model assets once, checking their hashes."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def main():
    assets = json.loads((ROOT / 'assets-manifest.json').read_text(encoding='utf-8'))
    for asset in assets:
        path = ROOT / asset['path']
        if path.is_file() and sha256(path.read_bytes()) == asset['sha256']:
            print(f"OK {asset['path']}")
            continue
        print(f"Downloading {asset['path']}")
        request = urllib.request.Request(asset['url'], headers={'User-Agent': '3waPersona/0.1'})
        with urllib.request.urlopen(request, timeout=45) as response:
            data = response.read()
        if asset.get('rewrite_gltf_import'):
            data = data.replace(b"'../utils/BufferGeometryUtils.js'", b"'./BufferGeometryUtils.js'")
        if sha256(data) != asset['sha256']:
            raise RuntimeError(f"Asset checksum mismatch: {asset['path']}")
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + '.part')
        try:
            temp.write_bytes(data)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
    print('Assets ready.')

if __name__ == '__main__':
    main()
