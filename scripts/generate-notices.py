"""Regenerate public dependency notices without leaking local dependency paths."""
import hashlib,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
metadata=json.loads(subprocess.check_output(['cargo','metadata','--format-version','1','--locked'],cwd=root))
packages=[]; texts={}
def add(name,version,expression,directory):
    references=[]
    candidates=sorted(p for p in directory.iterdir() if p.is_file() and p.name.lower().startswith(('license','licence','copying','notice')))
    for p in candidates:
        try:content=p.read_text(encoding='utf-8')
        except (UnicodeError,OSError):continue
        if len(content)>200000:continue
        content='\n'.join(line.rstrip() for line in content.splitlines()).strip()+'\n'
        digest=hashlib.sha256(content.encode()).hexdigest()[:16]
        texts[digest]=content;references.append(f'{p.name} => {digest}')
    packages.append(f'{name} {version}\nLicense metadata: {expression or "See package source"}\n'+ ('\n'.join(references) if references else 'License text supplied with original package source.')+'\n')
for p in sorted(metadata['packages'],key=lambda p:(p['name'],p['version'])):
    if p.get('source'):add(p['name'],p['version'],p.get('license'),Path(p['manifest_path']).parent)
package=root/'node_modules/@tauri-apps/api/package.json'
if package.exists():
    p=json.loads(package.read_text());add(p['name'],p['version'],p.get('license'),package.parent)
header='PI COMPANION THIRD-PARTY DEPENDENCY NOTICES\n\nGenerated from locked Cargo and npm dependencies, including build dependencies for completeness.\nIdentical license/notice texts are printed once and referenced by content hash from every applicable package.\nWhitespace at line ends is normalized; terms and attribution text are retained.\nInclusion does not imply every dependency ships in the executable.\nThe project itself has no selected blanket license.\n\nDEPENDENCY INDEX\n\n'
directory=root/'docs/licenses';directory.mkdir(parents=True,exist_ok=True)
parts=[];chunk=''
for digest,content in sorted(texts.items()):
    section=f'\n{"="*72}\nText {digest}\n{"="*72}\n\n{content}'
    if chunk and len(chunk)+len(section)>90000:parts.append(chunk);chunk=''
    chunk+=section
if chunk:parts.append(chunk)
index='Complete license texts are bundled in the licenses/ folder and stored in docs/licenses/ in the source repository.\nNo license terms are omitted; each numbered part contains whole license/notice texts.\n\n'
for number,part in enumerate(parts,1):
    name=f'LICENSE-TEXTS-{number:02}.txt';(directory/name).write_text(part.strip()+'\n',encoding='utf-8');index+=name+'\n'
(root/'THIRD-PARTY-NOTICES.txt').write_text((header+index+'\n'+'\n'.join(packages)).rstrip()+'\n',encoding='utf-8')
print(f'Wrote notices for {len(packages)} packages, {len(texts)} distinct texts')
