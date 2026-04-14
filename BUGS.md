Cannot click on nodes, perhaps its because the screen movement takes precedence over node clicks? We actually can't click on cluster labels either.

svg.addEventListener('mouseup' | 'mousedown') is never triggered!
----
Pressing on X moves all of the nodes in a circular pattern. This should absolutely not be the case, most likely a result of a fallback? There should be no fallback here, nodes should be placed on a multidimensional surface and simply performs gradient descent that relaxes all edges to their minimums. Maybe this relaxation of edges is responsible for generating an arc. In which case we need to rethink how gradient descent is performed.
----
Z does not cleanly return to previous positions. ALL nodes and edges should lerp back to their original locations (of the previous saved time step).

Also, nodes and edges are being removed one at a time for the layout.
----
renderGraphRecursive is obviously showing MAXIMUM UPDATE DEPTH EXCEEDED errors.
----
