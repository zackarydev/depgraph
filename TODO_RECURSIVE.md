## Recursive / fractal displays.

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