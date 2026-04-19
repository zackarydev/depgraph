# Optimizations

Particularly costly, also done extremely often, 1.2ms.
Also, `fullRender` caused by `renderEdgesDiff` called extremely often, from upsertEdge.

It's ok though, since it happens fairly rarely but it is a singular block of the thread for 133ms. Wondering if we should split it up, ex: webworker? 

