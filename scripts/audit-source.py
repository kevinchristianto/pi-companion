"""Small publication boundary check. This supplements, not replaces, manual review."""
from pathlib import Path
import re,sys,json,hashlib
root=Path(__file__).resolve().parents[1]
skip={'.git','node_modules','target','dist','gen'}
patterns=[r'libfile_[a-f0-9]+',r'/workspace/',r'/home/agent/',r'Sentinel_[a-f0-9]+',r'gh[pousr]_[A-Za-z0-9]{20,}',r'github_pat_[A-Za-z0-9_]{30,}',r'sk-(?:proj-)?[A-Za-z0-9_-]{32,}',r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----']
problems=[]
for p in root.rglob('*'):
 if not p.is_file() or any(x in skip for x in p.relative_to(root).parts) or p.suffix in {'.png','.ico'}:continue
 if p.name=='audit-source.py':continue
 try:text=p.read_text(encoding='utf-8')
 except UnicodeError:continue
 for pattern in patterns:
  if re.search(pattern,text):problems.append(str(p.relative_to(root))+': matched protected source pattern')
for p in root.rglob('*'):
 if not p.is_file() or any(x in skip for x in p.relative_to(root).parts):continue
 if p.name in {'.env','connection.json','.pi-office-token'}:problems.append(str(p.relative_to(root))+': runtime credential file must not be published')
if problems:print('\n'.join(problems));sys.exit(1)
print('Public source audit: no private workspace references, Library identities, common credential patterns or runtime connection files.')
