from pathlib import Path
from PIL import Image, ImageDraw


source_dir = Path("/Users/fanzengxia/Documents/GitHub/frontmind-dashboard/tmp/pdfs")
pages = sorted(source_dir.glob("policy-*.png"))
output_dir = source_dir / "policy-contact-sheets"
output_dir.mkdir(parents=True, exist_ok=True)

thumb_width = 620
thumb_height = 875
gap = 24
label_height = 34
sheet_width = gap * 3 + thumb_width * 2
sheet_height = gap * 3 + (thumb_height + label_height) * 2

for batch_index in range(0, len(pages), 4):
    batch = pages[batch_index : batch_index + 4]
    canvas = Image.new("RGB", (sheet_width, sheet_height), "white")
    draw = ImageDraw.Draw(canvas)
    for offset, page_path in enumerate(batch):
        page = Image.open(page_path).convert("RGB")
        page.thumbnail((thumb_width, thumb_height))
        row, col = divmod(offset, 2)
        x = gap + col * (thumb_width + gap)
        y = gap + row * (thumb_height + label_height + gap)
        canvas.paste(page, (x + (thumb_width - page.width) // 2, y + label_height))
        draw.text((x, y + 6), page_path.stem, fill="black")
    output_path = output_dir / f"sheet-{batch_index // 4 + 1}.png"
    canvas.save(output_path)
