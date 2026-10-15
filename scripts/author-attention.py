"""Reproducible local attention-only pixel authoring. No provider calls or resampling.
Inputs are preserved derivative atlases and restored torso plates from the original
per-character authoring pipeline. Raw generated sources remain unchanged.
"""
from pathlib import Path
from PIL import Image, ImageDraw
import argparse, hashlib, json
ROOT=Path(__file__).resolve().parents[1]
INPUT=ROOT/'art-source/attention'
ASSETS=ROOT/'src/assets/pixel-office'
CONFIG={
 'moss-curls':dict(s=(44,28),e=(48,34),w=(50,27),old=((41,28),(49,36),(50,26)),hand=(49,20,53,27),colors=('#312816','#7f7e2a','#534b19')),
 'amber-braid':dict(s=(37,28),e=(41,34),w=(43,27),old=((37,28),(44,35),(45,26)),hand=(43,21,47,27),colors=('#211d18','#967322','#7b5420')),
 'plum-bun':dict(s=(38,28),e=(42,34),w=(44,27),old=((38,28),(47,36),(47,25)),hand=(46,19,50,26),colors=('#200613','#98435e','#60213d')),
 'sky-part':dict(s=(41,25),e=(44,31),w=(46,24),old=((41,25),(49,34),(49,24)),hand=(47,17,51,24),colors=('#000000','#98c5e9','#5981a9')),
 'coral-coils':dict(s=(39,27),e=(43,33),w=(45,26),old=((39,27),(47,35),(48,25)),hand=(47,18,51,25),colors=('#000000','#c53c35','#761f22')),
 'sage-bob':dict(s=(40,24),e=(43,30),w=(45,23),old=((40,24),(47,32),(48,23)),hand=(46,17,50,23),colors=('#090917','#4f4e4d','#2a2d31')),
}

def pose(identity,flex=0):
 c=CONFIG[identity];im=Image.open(INPUT/f'{identity}-torso.png').convert('RGBA');d=ImageDraw.Draw(im)
 sx,sy=c['s'];ex,ey=c['e'];wx,wy=c['w'];outline,light,shade=c['colors']
 # Upper sleeve remains attached to the original shoulder; elbow is close to ribs.
 d.polygon([(sx-2,sy),(sx,sy-2),(sx+2,sy),(ex+1,ey-1),(ex+1,ey+1),(ex-1,ey+1),(sx,sy+3)],fill=outline)
 d.polygon([(sx-1,sy),(sx,sy-1),(sx+1,sy),(ex,ey-1),(ex,ey),(ex-1,ey-1),(sx,sy+2)],fill=light)
 d.line([(sx,sy+2),(ex-1,ey)],fill=shade)
 # Forearm leans only 2px outward; distinct cuff and elbow crease, no long V.
 d.polygon([(wx-2,wy),(wx+1,wy),(ex+2,ey-1),(ex+1,ey+1),(ex-1,ey+1),(ex-2,ey),(wx-2,wy+1)],fill=outline)
 d.polygon([(wx-1,wy+1),(wx,wy+1),(ex+1,ey-1),(ex,ey),(ex-1,ey-1)],fill=light)
 d.line([(wx-1,wy+2),(ex-1,ey-1)],fill=shade)
 d.line([(wx-1,wy),(wx,wy)],fill=shade)
 # Reuse the exact native palm pixels. Only the top two finger rows flex 1px.
 atlas=Image.open(INPUT/f'{identity}-before.png').convert('RGBA');old=atlas.crop((0,192,64,256));hand=old.crop(c['hand'])
 hx=wx-2;hy=wy-hand.height
 for y in range(hand.height):
  for x in range(hand.width):
   color=hand.getpixel((x,y))
   if color[3]:im.putpixel((hx+x+(flex if y<2 else 0),hy+y),color)
 return im

def compose(identity,frame):
 out=Image.open(ASSETS/'shared/chair.png').convert('RGBA');out.alpha_composite(frame)
 for name in ['desk','laptop']:out.alpha_composite(Image.open(ASSETS/'shared'/f'{name}.png').convert('RGBA'))
 # Attention foreground hand row is empty in the source and is left untouched.
 return out

def previews(out):
 out.mkdir(parents=True,exist_ok=True);bg='#d1c5ad';ids=list(CONFIG);frames=[];comparisons=[]
 for i,flex in enumerate([0,0,1,1,0,0,0,0]):
  page=Image.new('RGB',(416,340),bg);d=ImageDraw.Draw(page);comp=Image.new('RGB',(816,340),bg);cd=ImageDraw.Draw(comp)
  d.text((12,8),'ATTENTION / NEEDS INPUT / REVIEW - SPRITE PREVIEW',fill='#302b29');cd.text((12,8),'BEFORE (LEFT) / AFTER (RIGHT) - SPRITE PREVIEW',fill='#302b29')
  for j,n in enumerate(ids):
   x=8+(j%3)*136;y=30+(j//3)*154;d.text((x+3,y),n,fill='#302b29')
   art=compose(n,pose(n,flex)).resize((128,128),Image.Resampling.NEAREST);page.paste(art,(x,y+14),art)
   cx=8+(j%3)*272;cd.text((cx+4,y),n,fill='#302b29')
   old=Image.open(INPUT/f'{n}-before.png').convert('RGBA').crop((i*64,192,(i+1)*64,256));old=compose(n,old).resize((128,128),Image.Resampling.NEAREST)
   comp.paste(old,(cx,y+14),old);comp.paste(art,(cx+132,y+14),art)
  frames.append(page);comparisons.append(comp)
 for name,items in [('attention-compact-cast',frames),('attention-before-after',comparisons)]:
  items[0].save(out/f'{name}.png')
  items[0].save(out/f'{name}.apng',save_all=True,append_images=items[1:],duration=250,loop=0,disposal=0,blend=0)
  # Fixed global GIF display palette prevents color flicker. PNG/APNG are exact.
  palette=items[0].quantize(colors=256,method=Image.Quantize.MEDIANCUT)
  indexed=[im.quantize(palette=palette,dither=Image.Dither.NONE) for im in items]
  indexed[0].save(out/f'{name}.gif',save_all=True,append_images=indexed[1:],duration=250,loop=0,disposal=2,optimize=False)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--preview-dir',type=Path);parser.add_argument('--write',action='store_true');args=parser.parse_args()
 if args.preview_dir:previews(args.preview_dir)
 if args.write:
  for name, sha in json.loads((INPUT/'INPUTS.json').read_text())['files'].items():
   assert hashlib.sha256((INPUT/name).read_bytes()).hexdigest()==sha, f'Authoring input changed: {name}'
  for n in CONFIG:
   atlas=Image.open(INPUT/f'{n}-before.png').convert('RGBA')
   current=Image.open(ASSETS/'characters'/f'{n}.png').convert('RGBA')
   assert current.crop((0,0,512,192)).tobytes()==atlas.crop((0,0,512,192)).tobytes(), f'Unrelated animation changes in {n}; review before writing'
   for i,flex in enumerate([0,0,1,1,0,0,0,0]):atlas.paste(pose(n,flex),(64*i,192))
   atlas.save(ASSETS/'characters'/f'{n}.png')

  manifest_path=ASSETS/'ASSET-SOURCES.json'
  manifest=json.loads(manifest_path.read_text())
  for item in manifest['files']:
   item['sha256']=hashlib.sha256((ASSETS/item['path']).read_bytes()).hexdigest()
  manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
