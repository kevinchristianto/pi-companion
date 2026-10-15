"""Pixel contracts for attention-only authoring (Pillow developer dependency)."""
import hashlib, json, math, runpy, unittest
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
NS=runpy.run_path(str(ROOT/'scripts/author-attention.py'))
CONFIG=NS['CONFIG'];INPUT=NS['INPUT'];ASSETS=NS['ASSETS']
class AttentionAuthoring(unittest.TestCase):
 def test_frozen_inputs(self):
  for name,sha in json.loads((INPUT/'INPUTS.json').read_text())['files'].items():
   with self.subTest(name=name):self.assertEqual(hashlib.sha256((INPUT/name).read_bytes()).hexdigest(),sha)
 def test_six_designs(self):
  self.assertEqual(set(CONFIG),{'moss-curls','amber-braid','plum-bun','sky-part','coral-coils','sage-bob'})
 def test_shorter_individual_geometry(self):
  for n,c in CONFIG.items():
   with self.subTest(design=n):
    s,e,w=c['s'],c['e'],c['w'];old=c['old']
    self.assertLessEqual(e[0]-s[0],4);self.assertEqual(e[1]-s[1],6)
    self.assertLessEqual(abs(w[0]-e[0]),2);self.assertEqual(e[1]-w[1],7)
    self.assertLessEqual(math.dist(s,e),8);self.assertLessEqual(math.dist(e,w),8)
    self.assertLess(math.dist(s,e)+math.dist(e,w),.78*(math.dist(old[0],old[1])+math.dist(old[1],old[2])))
 def test_source_palette_and_binary_alpha(self):
  for n in CONFIG:
   old=Image.open(INPUT/f'{n}-before.png').convert('RGBA');colors=set(old.getdata())
   for flex in [0,1]:
    with self.subTest(design=n,flex=flex):
     frame=NS['pose'](n,flex);self.assertEqual(frame.size,(64,64));self.assertLessEqual(set(frame.getchannel('A').getdata()),{0,255})
     self.assertTrue({p for p in frame.getdata() if p[3]}<=colors)
     self.assertTrue(all(2<=x<=61 and 2<=y<=61 for y in range(64) for x in range(64) if frame.getpixel((x,y))[3]))
 def test_only_fingers_move(self):
  for n,c in CONFIG.items():
   a,b=NS['pose'](n,0),NS['pose'](n,1);hand_top=c['w'][1]-(c['hand'][3]-c['hand'][1]);changed=[]
   for y in range(64):
    for x in range(64):
     if a.getpixel((x,y))!=b.getpixel((x,y)):changed.append((x,y))
   with self.subTest(design=n):
    self.assertTrue(changed);self.assertTrue(all(hand_top<=y<hand_top+2 for x,y in changed))
    self.assertTrue(all(c['w'][0]-2<=x<=c['w'][0]+2 for x,y in changed))
 def test_raised_hand_does_not_overwrite_head(self):
  for n,c in CONFIG.items():
   torso=Image.open(INPUT/f'{n}-torso.png').convert('RGBA')
   for flex in [0,1]:
    frame=NS['pose'](n,flex)
    for y in range(c['s'][1]-3):
     for x in range(64):
      if torso.getpixel((x,y))[3]:
       with self.subTest(design=n,flex=flex,pixel=(x,y)):self.assertEqual(frame.getpixel((x,y)),torso.getpixel((x,y)))
 def test_no_detached_hand_or_arm(self):
  for n,c in CONFIG.items():
   for flex in [0,1]:
    frame=NS['pose'](n,flex);points={(x,y) for y in range(15,42) for x in range(25,58) if frame.getpixel((x,y))[3]};seen={c['s']};todo=list(seen)
    while todo:
     x,y=todo.pop()
     for p in [(x-1,y),(x+1,y),(x,y-1),(x,y+1)]:
      if p in points and p not in seen:seen.add(p);todo.append(p)
    with self.subTest(design=n,flex=flex):
     self.assertIn(c['e'],seen);self.assertIn(c['w'],seen)
     self.assertTrue(any(y<c['w'][1] and x>=c['w'][0]-1 for x,y in seen))
 def test_all_other_rows_and_hands_unchanged(self):
  for n in CONFIG:
   with self.subTest(design=n):
    before=Image.open(INPUT/f'{n}-before.png').convert('RGBA');actual=Image.open(ASSETS/'characters'/f'{n}.png').convert('RGBA')
    self.assertEqual(actual.crop((0,0,512,192)).tobytes(),before.crop((0,0,512,192)).tobytes())
    for i,flex in enumerate([0,0,1,1,0,0,0,0]):self.assertEqual(actual.crop((i*64,192,(i+1)*64,256)).tobytes(),NS['pose'](n,flex).tobytes())
    hands=Image.open(ASSETS/'characters'/f'{n}-hands.png').convert('RGBA')
    self.assertIsNone(hands.crop((0,192,512,256)).getbbox())
if __name__=='__main__':unittest.main()
