# depgraph todo

When a node is clicked all nodes connected to it should start being pulled in to the clicked node.

The Harder/longer a node is pressed the more the links strength is high. Other clusters may need to be completely deformed to allow it. Ensure that AST importance is maintained with respect to node separation.


Run claude when the AST is done, and ask him to group them with respect to importance, and grouped by "idea", within the context of the repository its in.

Pressing on X should apply slight forces on the currently selected nodes. Selected nodes occur when Shift-Clicking. Upon pressing and holding X forces are applied. After releasing all nodes become fixed in place. Note that the forces applied to nodes during X should be to spread them out, and to restore cohesion between modules based on the edge weights.

Edge weights should change dynamically based on the current context the user is navigating. Please change the Time Arrows to be a bit more advanced. Goto T0, goto Last, 

zKeyRaf, it's being written to in zLoop which occurs INSIDE startZTimeTravel, but its not being shown as being written by startZTimeTravel. Most likely because its associated to zLoop... But zLoop is hidden because its a local function declaration... Although I might expect zLoop to also be a node defined in the hypergraph, this would require zoom-dependency. Because if i'm looking inside of the Time Travel cluster, 3 nodes only, I probably also want to see the internals of startZTimeTravel.

![zKeyRAF written by internal function](image.png)