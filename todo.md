# depgraph todo

Run claude when the AST is done, and ask him to group them with respect to importance, and grouped by "idea", within the context of the repository its in.

Edge weights should change dynamically based on the current context the user is navigating. Please change the Time Arrows to be a bit more advanced. Goto T0, goto Last, 

zKeyRaf, it's being written to in zLoop which occurs INSIDE startZTimeTravel, but its not being shown as being written by startZTimeTravel. Most likely because its associated to zLoop... But zLoop is hidden because its a local function declaration... Although I might expect zLoop to also be a node defined in the hypergraph, this would require zoom-dependency. Because if i'm looking inside of the Time Travel cluster, 3 nodes only, I probably also want to see the internals of startZTimeTravel.

![zKeyRAF written by internal function](image.png)

---

With respect to simulator adding nodes in realtime. I think that sometimes clusters don't even exist until they appear but the hypergraph isn't updated. I feel like when new nodes are added they should PULL and REPULSE based on the edges in the hypergraph. Maybe we need to create a new control that is "Apply Edge weights", perhaps that's what the "X" control should've been. But just to keep things distinct, a new control should be created. I propose F for forces.

---

Some of the cluster labels are rendered WAY too far away from their cluster. Perhaps it should be spring based? Or perhaps it has something to do with the cluster islands, ex: if the cluster is sparse, maybe we need to have multiple labels?! Maybe clusters should be more dynamic. Based on nodes in close proximity. Clusters can recombine together to form a bigger cluster, depending on its nodes' positions. I love the idea of clusters within clusters. Nodes within nodes. I think its time to start considering clusters as nodes.

---

There's an bug where if the cluster nodes are FAR away, the repulsion mechanism of cluster probably creates a centroid-repulsion. So everything gets repulsed around that centroid location. Resulting in some chaotic repulsion/pull forces. My guess is that cluster attraction is probably cheap to do, but its probably being done naively via meta edges. Those meta edges should instead create connectivity islands based on the position of the nodes in the UI too. Ex: a cluster with nodes that are physically far apart should probably create new meta edges, effectively separating the cluster. Perhaps.

---
Control + Clicking in white space should create a repulsion bubble at that location, not to be confused with "returning to their T0 position" which is the current behavior.

---
Write a hypergraph navigation helper at the top right hand corner of the screen. There, controls can be explained dynamically based on what the user is doing. Ex: if they haven't clicked on a node, the nav helper can say "click a node", "hold click a node". Once the user hold click a node, the navigation helper can say "Space to Gather", and "Drag to Move". To name a few examples. If we can do this for all controls it could be cool. Also I think the controls.md file is out of date with respect to the features in the code. Can you scan to make sure we didn't miss anything, or if there's a mismatched between whats in the controls and in the code.

---
We've got the streamer setup. This broadcast nodes to the UI.

I'm wondering if we should have some kind of "wait for frontend acknowledgement" that its ready for the next data point.

---
And I think we also kind of forgot that edges could also potentially have importance. It's actually perhaps more of a frontend thing (based on the pullLayerState). Don't do anything about that, but lets keep in mind that perhaps those two concepts are intertwined and could require a better system. Because this will be DYNAMIC as HELL.

---
We need to add new nodes. I want the entire code base to encoded in the hypergraph. You'll probably need to refactor the graphgen AST parsing code. I want to see each object, their keys (as edge labels) and the value as another node in the hypergraph. All variables should be declared, and their internals functionalities as well should be encoded in the hypergraph. The UI layer should be the one dictating what's visible or not, not the AST parsing into the csv files. The node types for variables could be specific. 

I tried to implement this but got lost in the codegen/graphgen/historygen files, it might be worth it to share code between the two ways...

---
Need a way to hide certain node types, perhaps based on the edges. Ex: I odn't want to see func args, or func params. But I want to see globals. Or I don't want to see funcs, I want to see classes etc.