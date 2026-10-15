# Compact attention arm revision

These are developer-only authoring inputs, not additional runtime assets. The six
`*-before.png` atlases preserve the prior code-authored artwork. Each `*-torso.png`
is the exact, registered torso restoration plate from its original character's
procedural authoring pipeline, with the near arm removed. `INPUTS.json` pins them.
The original PixelLab generated sources remain unchanged in the source archive;
their hashes are recorded in the runtime asset provenance.

The local revision changes only attention (atlas row 3). It places the elbow
3–4 native pixels outward and 6 down from the shoulder, then brings the forearm
7 pixels up with a 2-pixel outward lean. Moss anchors at its outer jacket shoulder
to preserve its wide bob silhouette. Exact original palm pixels are reused; only
the top two finger rows flex one pixel. No whole-body motion or resampling occurs.

Run with Python and Pillow (authoring was checked with Pillow 12.3.0):

    python scripts/author-attention.py --write --preview-dir /tmp/attention-preview
    python -m unittest discover -s test -p '*_test.py' -v
    npm run typecheck
    npm test

The generated PNG/APNG previews preserve exact colors at integer 2× enlargement.
GIF previews use one fixed 256-color display palette; runtime PNGs keep the
original colors and binary transparency. Previews are sprite composites, not
native-window screenshots. The compact sprite previews were accepted on 2026-10-15. The revised assets remain local until the next reviewed application publication.

No generated raw source, shared prop, foreground-hand atlas, idle, typing, or
thinking pixels are modified. The runtime maps both `waiting` (Needs input) and
`error` (Error/review attention) to attention, including reduced-motion frame 0.
