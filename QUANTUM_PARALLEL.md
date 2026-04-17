[Other.]

---

[Zack:]

I actually want to push back against "state is not written to history" why not? What if I do want that. The thing I'm worried about is that a linear file is not the ideal way to store a graph this complex. How do we even store that?

---

[Agent answers something that is .... unsubstantial]
---

[Zack:]
I like your concept of hertz, state hertz. My thoughts is that the hypergraph will update at different rates. Different systems behave totally differently at runtime. PubSub is really cool for this scalability, but this is too primitive for the type of work were doing here. Although, the concepts that it evokes is extremely close to the problem were trying to solve with file watchers and file sinks. Just different names. At the end of the day, its just a different stream. So then, we have it. A multi-dimensional hypergraph condensced into a linear file. Where each edge can represent a potential stream. The reason why its a potential stream is the concept of a receiver vs a sender. An event emitter, vs a handler. A node of one concept vs a node that has another concept. Cause and effect. Or perhaps effect and cause. I still like the linear perspective of the history, I think that remains ultimately necessary. What's interesting though is what happens at extremely similar write times. A type of fuzziness occurs. Perhaps this is the ultimate uncertainability of quantum mechanics. What ends up happening is that the last time step will always have concurrent writes to the history. Especially at scale. It MUST HAVE CONCURRENT WRITES. So therefore what must happen is that all concurrent writes happen at the same time. And history is simply merged. Merged completely without deduplication or whatever. Right now I believe we use the timestamp for order. At high concurrency those timestamps will overlap, at which point we can use a n-dimensional-coordinate system to represent the space-and-time axiis of the hypergraph. But perhaps that's pushing it a bit too far. 

[Agent:]
SQL schema, fields; issue with lost causality if we don't have unique moment + seq id per producer; Khan networks / actor model / dataflow programming; Vector clocks are minkowski partial orders, "light cone" in physics.

----
[Zack:]
So first, I'd suggest something radical. As an event propagates through the hypergraph, what actually happens is that the hyper-edge of that moment gets applied to the graph. And nodes are updated based on what they're supposed to be doing. Ex: arithmetic (var = 5+4) or whatever else construction behaviours happen in software. When we write a function with two nodes we're expecting those two nodes to have a value and to be passed to the function. And then we expect to perform operations on those nodes. And so therefore the hypergraph should update and propagate those changes. What this really means is that there's a hyperedge of a given moment that ties certain nodes together. The moment is a hyperedge. And so we can think that at each time step T the moment cluster expands and shrinks and mutates by applying certain rules. The rules of software, the rules of the hypergraph. I think at its core it has to be software, or actually more accurately, mathematics, because everything boils down to assembly, and that is mathematics. 

The history.csv file storage is simply .... an implementation detail. The only difficulty, will be encoding partial hypergraphs, and storing them as independent storage units. Stitching them back together, ensuring there is not "fault lines" between hypergraph subsegments will be critical. The reason why I'm saying that "moments" can be fuzzy is to avoid this particular fault line dissonance. If its fuzzy we can protect against and anticipate where the hypergraph gets stored, how its ran and executed. If we have 5 trillion nodes, we will need these on different servers and then stitched back together. Therefore it is an unavoidable problem related to scaling

TODO: Read:  `interaction combinators from Lafont 1997`


---
[Agent:]

The unexpected insight hiding in your codebase
Depgraph's gradient-descent layout already is a hypergraph partitioner. Nodes with shared hyperedges attract; unrelated nodes repel. Let the graph settle, find the low-density regions between clusters, cut there. The spatial layout you're computing for rendering is, up to a coordinate change, the partitioning assignment for distributed execution.

This is not a coincidence and it's unusual for an architecture to get this for free. Your layout engine is your deployment planner. When you drag clusters apart in the UI, you are literally defining shard boundaries. That's the steering-while-running thing you asked about two turns ago — it collapses into "move nodes around, and the system re-partitions itself."

Fuzzy moments = timely dataflow's frontier model
The fuzziness-as-fault-line-protection instinct is exactly the Naiad/Timely Dataflow frontier model. Instead of "moment T has happened globally," you have "all events with timestamp ≤ T from shard S are now in." Different shards close their frontiers at different wall-clock times. A cross-shard rule only fires when all its members' shards have closed the relevant frontier. You never need global clock sync — only per-shard monotonic progress.

This is dramatically cheaper than Paxos/Raft-style consensus and it's the reason timely dataflow scales to huge clusters. Your fuzzy-moment intuition is the existing state of the art, not a workaround.