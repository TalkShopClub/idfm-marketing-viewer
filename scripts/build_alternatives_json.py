#!/usr/bin/env python3
"""Write alternatives.json, the static replacement for the original server's /api/alternatives."""
import argparse
import json
from pathlib import Path

PART_LABELS = {
    'v8_engine': 'V8 engine',
    'torsen_differential': 'Torsen differential',
    'tremec_transmission': 'Manual transmission',
    'k1_structural_frame': 'K1 structural frame',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('alternatives', type=Path, help='local part_alternatives_cad directory')
    parser.add_argument('previews', type=Path, help='local viewer/part-previews directory')
    parser.add_argument('--base', default='https://pub-e4ed9ee47da34f439841f3e766930fd6.r2.dev/')
    parser.add_argument('--out', type=Path, default=Path(__file__).resolve().parent.parent / 'alternatives.json')
    args = parser.parse_args()
    parts = []
    for key, label in PART_LABELS.items():
        alternatives = []
        for image in sorted((args.alternatives / key).glob('variation_*.png')):
            mesh = image.with_suffix('.glb')
            preview = args.previews / key / mesh.name
            mesh_stat = mesh.stat() if mesh.is_file() else None
            preview_stat = preview.stat() if preview.is_file() else None
            alternatives.append({
                'id': image.stem,
                'number': int(image.stem.split('_')[1]),
                'image': f'{args.base}alternative-assets/{key}/{image.name}',
                'mesh': f'{args.base}alternative-assets/{key}/{mesh.name}',
                'mesh_ready': mesh_stat is not None,
                'mesh_bytes': mesh_stat.st_size if mesh_stat else 0,
                'mesh_version': str(mesh_stat.st_mtime_ns) if mesh_stat else None,
                'preview': f'{args.base}part-previews/{key}/{mesh.name}',
                'preview_ready': preview_stat is not None,
                'preview_bytes': preview_stat.st_size if preview_stat else 0,
                'preview_version': str(preview_stat.st_mtime_ns) if preview_stat else None,
            })
        parts.append({'id': key, 'label': label, 'alternatives': alternatives})
    args.out.write_text(json.dumps({'parts': parts}, indent=1) + '\n')


if __name__ == '__main__':
    main()
