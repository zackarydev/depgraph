## Fractalization UI

[Zack:]

When clicking on a node and trying to move it, we should not see right away that a click occurred. It should appear "in the background" of the hypergraph. The user must scroll in to view the other layer of changes. This occurs progressively as the user zooms in. 

These could feel like "hard" transitions. 

Its a very different with other node types, like images, where these I really love the transition, smooth. 

The user must have the ability to "lock" this fractal height. That way they can zoom out and see more of the hypergraph and interact with gradient descents while at that fractal layer.

--
Also, must fix the automatic hull stuff. It's for sure connected to the fractal visibility because when zoomed out we don't see nodes but the hulls are still as if the nodes were there. It also highlights that these nodes, the invisible nodes, are still rendered and part of the loaded hypergraph. At small scales this is probably fine, but we're past that. We now need to probably dynamically load the hypergraph based on fractal distances.

I propose we build this directly into the hypergraph, of course, probably need "history marker" sentinel nodes. These are attached to a fractal visualizer, and loader (probably). I'd recommend splitting the two functionalities up.

As history is written sentinel nodes can be placed that marks time. As the program loads, these sentinels are queued up in a quadtree(?) or other efficient storage/query structure.

User position in screenspace and in hypergraphspace is translatable. At least fractal height, but I'd go as far as putting their screen coordinates directly in the hypergraph. Each time they move the nodes and edges flow into the history file. Probably out of scope for first version. Write a doc for this expansion plan.

Alas. Upon transitions from one fractal layer to another, these sentinel nodes would be used to look in the past/future of the hypergraph, at those locations. The reason this is hard to grasp is because the node positions in the hypergraph space is a combination of its previous positions (in history), but also the currently loaded hypergraph visual renderings (i.e. positions of the nodes on screen before the appearance of the next fractal layer). Note that the fractal layer is throughout the whole screen, in microdimensions everywhere, as opposed to directional, although it could certainly be directional, partial. I actually really love the idea of partial. I.e. all the black space is available for **fractalization**.


---- 
[Claude:]
Strongest resonances with VISION.md:

Fractal tiers are "scale invariance" made operational. VISION treats seamless zoom as aspirational; this proposal gives it a mechanism — each tier is a structural/semantic layer, and zoom transitions between them.
Hard vs. smooth is the Wolfram split. Structural rewrites (click-drag, rule firings) are discrete — "hard." Visual/spatial evolution (image pan, force settle) is smooth. You're already intuiting the distinction; worth naming it in the design doc.
Sentinels are the observer's reference frame, concretized inside the graph. VISION's "Observer-Dependent Rendering" leaves the frame abstract; sentinels make it a coordinate that lives in the hypergraph. The observer becomes just another node — nice unification.
The load-bearing questions I'd want pinned before writing code or the expansion doc:

Is fractal height discrete or continuous? "Lock the fractal height" implies named tiers. I'd propose discrete tiers + continuous zoom within a tier, and the tier-to-tier transition is where the "hard" animation lives. Confirm?

Where does a click-drag at layer N land? Two different semantics:

(a) Layer N+1 is the rewrite of N — the click fires a rule, and N+1 is the consequence appearing underneath.
(b) N+1 is just a deeper sub-structure of the same node, unrelated to the edit. Your phrasing ("appears in the background, scroll in to view") reads like (a). Is that right? This decides whether sentinels are rule-application markers or zoom-checkpoint markers.
Sentinels — spatial index or temporal index? "Quadtree" is spatial, "history marker" is temporal. I suspect you want both axes on each sentinel (position + step), with the quadtree indexing the spatial axis so you can ask "which sentinels are near this screen region?" — then resolve time per-sentinel. Confirm?

Position blending on layer transition. "Combination of prior history positions + currently loaded positions" is under-specified and does most of the work. My guess at what you mean: entering layer N+1, child node positions inherit from the parent's N-layer position, then settle via force-directed — with sentinels providing "last known N+1 positions here" as a warm start to avoid re-falling into local minima (matches your streaming-construction preference). Is that the model?

Hulls across fractal layers. A hyperedge can span nodes at different visible layers. When only some members are at the current layer: (a) shrink hull to visible members, (b) render hull with ghost extensions toward off-layer members, (c) don't render. (b) matches the manifold/horizon aesthetic in VISION. The current bug (hulls computed over invisible nodes) is essentially a degenerate form of (b) without the ghost rendering.

Partial fractalization in black space vs. the horizon. VISION uses black space as the horizon for frame-irrelevant data. You want to fractalize into black space. These can be unified (relevance = inverse of distance-to-frame → irrelevant data gets pushed into the fractal sub-layer, which is where detail lives anyway). Elegant if intentional — worth stating explicitly.

One flag for the expansion doc on screen-position-in-hypergraph: if every viewport change writes to history, the history file becomes mostly camera noise. Probably want viewport in the graph only at explicit checkpoints (user-dropped sentinels or significant transitions), not continuously. Otherwise the "oscillating participants" get drowned in pan events.

I'd want your take on 2, 3, 4, and 6 before I draft the expansion doc — those four decisions constrain the sentinel schema and the loader/visualizer split.

---
Zack:
Unknown... too complex.. need time.