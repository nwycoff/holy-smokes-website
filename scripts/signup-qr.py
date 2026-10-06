"""Developer-only: pip install qrcode==8.2, then python scripts/signup-qr.py.
No network calls, personal information, or runtime Python dependency.
"""
from pathlib import Path
import qrcode
from qrcode.image.svg import SvgPathFillImage

sources = ('register-1', 'register-2', 'bag-card-v1', 'menu-tvs', 'website')
out = Path(__file__).resolve().parent.parent / 'assets' / 'signup-qr'
out.mkdir(parents=True, exist_ok=True)
for source in sources:
    url = f'https://www.treehousepharmacy.com/go/{source}'
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
    qr.add_data(url)
    qr.make(fit=True)
    qr.make_image(image_factory=SvgPathFillImage).save(out / f'{source}.svg')
    print(f'{source}: {url}')
