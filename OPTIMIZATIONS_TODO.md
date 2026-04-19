# Optimizations

## Rendering

`setAttribute`? Too often called. Indication that 3rd party is insufficient. Investigate 3D, probably closer ? And can visualize gradient descent ? 

`positionClusterLabelsFromDisplay`
`renderPositionsOnly` 14.8%

Chrome "Recalculate style" ? 10.4%
Chrome "Layout" ? 9.1%

The main issue is almost certainly the dom elements. Its just not the right medium for this. Must switch ASAP?


## OK:

updateGradient at 4.5%, interesting. WebWorker faster?

## Fix:

Uncaught ReferenceError: clusterDragState is not defined

depgraph: localStorage save failed Failed to execute 'setItem' on 'Storage': Setting the value of 'depgraph:history' exceeded the quota.
- Just slow?


