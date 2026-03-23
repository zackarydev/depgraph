# depgraph todo

When a node is clicked all nodes connected to it should start being pulled in to the clicked node.

The Harder/longer a node is pressed the more the links strength is high. Other clusters may need to be completely deformed to allow it. Ensure that AST importance is maintained with respect to node separation.


Run claude when the AST is done, and ask him to group them with respect to importance, and grouped by "idea", within the context of the repository its in.

Pressing on X should apply slight forces on the currently selected nodes. Selected nodes occur when Shift-Clicking. Upon pressing and holding X forces are applied. After releasing all nodes become fixed in place. Note that the forces applied to nodes during X should be to spread them out, and to restore cohesion between modules based on the edge weights.

Edge weights should change dynamically based on the current context the user is navigating. Please change the Time Arrows to be a bit more advanced. Goto T0, goto Last, 

Controls do not work.
