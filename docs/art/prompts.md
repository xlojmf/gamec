# Image generation recipes

Generated with the built-in imagegen tool. Source PNGs are preserved in public/assets/astra. Each material was generated in a separate call. Vector UI assets and dice were authored as SVG for sharp, exact shapes and pip counts.

## Concept / landing hero

Create a premium cozy hand-painted tabletop island game concept board, landscape 1536x1024. A beautiful miniature hexagonal island of 19 hex tiles, pine forests, sheep meadows, golden wheat fields, terracotta clay hills, slate mountains and sandy desert, little painted wooden red and blue settlements and roads, ivory numbered chits, surrounded by turquoise ocean in a crafted dark walnut hexagonal tray with brass edge. Warm afternoon sun from upper left, soft ambient occlusion, tactile gouache-painted wood, refined editorial composition. Main isometric island occupies right two-thirds; left third deep midnight teal empty negative space with subtle nautical chart lines suitable for live HTML title overlay. Bottom edge small material and palette swatches integrated tastefully. No words, no letters, no logos, no watermark. Art direction reference and actual game landing hero.

## forest-top

Game-ready seamless square terrain material, orthographic top-down flat albedo texture filling the entire image edge to edge. Cozy hand-painted miniature tabletop pine forest floor: mossy deep evergreen ground, tiny fern brush strokes, soft scattered pine needles and subtly lighter moss patches. No actual trees, no objects, no shadows, no lighting gradients, no border, no text, no hex shape. Low contrast and fine tactile gouache grain. Intended to wrap over a 3D boardgame hex beneath miniature tree models. 1024x1024.

## pasture-top

See the shared material direction in art-direction.md.

## fields-top

See the shared material direction in art-direction.md.

## hills-top

See the shared material direction in art-direction.md.

## mountains-top

See the shared material direction in art-direction.md.

## desert-top

See the shared material direction in art-direction.md.

## forest-side

See the shared material direction in art-direction.md.

## pasture-side

See the shared material direction in art-direction.md.

## fields-side

See the shared material direction in art-direction.md.

## hills-side

See the shared material direction in art-direction.md.

## mountains-side

See the shared material direction in art-direction.md.

## desert-side

See the shared material direction in art-direction.md.

## water

See the shared material direction in art-direction.md.

## frame

See the shared material direction in art-direction.md.

## token-plate

See the shared material direction in art-direction.md.

## September 11 — miniature detail materials

Mode: native `image_gen.imagegen`, three independent outputs. Each used `public/assets/astra/concept/island.png` as a style reference. Original generated PNGs are preserved; copies are registered in manifest v2. No CLI or API fallback was used.

### details/slate-v1.png

Use case: stylized-concept. Asset type: seamless square albedo texture for the actual 3D mountain meshes in a handcrafted board game. Input image is a STYLE REFERENCE only. Produce a brand new material texture, NOT a scene or a mountain object. Close-up flat orthographic surface of the gray mountain rock in the reference: fine striated slate and granite, tiny mineral flecks, subtle quartz seams, muted cool-gray stone, restrained pale lichen. Organic layered fracture lines, detailed carved miniature texture, neutral even diffuse light so runtime 3D lighting controls shadows. Fill the whole square edge to edge, tileable in both axes. No rendered object, no perspective, no hexagon, no border, no text, no numerals, no snow, no big black cracks. Medium-gray overall with fine tonal detail suitable for tinting, not a high-contrast noisy pattern.

### details/painted-wood-v1.png

Use case: stylized-concept. Asset type: seamless square albedo texture for colored carved wooden settlement and city pieces in this board game. Input image is a STYLE REFERENCE only. Produce a new flat material texture, NOT a house or scene. Light neutral honey-beige finely sanded hardwood with subtle parallel flowing grain, minute open pores and faint carving marks. Understated hand-finished tabletop miniature quality, no bold knots. Even orthographic diffuse illumination, no directional cast shadows, no gloss hotspot. Full square edge-to-edge tileable wood surface. This will be multiplied by red, blue, orange and ivory player paint in a shader, so keep neutral light values and delicate contrast. No text, no logos, no object, no border, no panel seams or nails.

### details/fir-needles-v1.png

Use case: stylized-concept. Asset type: seamless square albedo texture for a dense forest of sculpted miniature fir trees in a 3D board game. Input image is a STYLE REFERENCE only. Produce a new close-up flat seamless MATERIAL texture, not a tree or landscape. Dense tiny dark evergreen fir needles, subtle layered tufts in varying green and olive shades, natural mossy matte finish matching miniature forest in the reference. Needle-scale detail with warm muted green highlights and dark green recesses, balanced low contrast, flat evenly diffuse light. Fill square edge to edge, tileable both axes. No silhouette, no trunk, no branches as large standalone shapes, no sky, no border, no text. Avoid broad leaf shapes and avoid an overhead view of a whole forest.
