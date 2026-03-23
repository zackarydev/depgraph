# depgraph

[Videos](https://youtu.be/slwxspOzzK0)

### Codemap

![Codemap](<./screenshots/Screenshot 2026-03-21 at 2.15.53 PM.png>)

### Hypergraph of Codemap + AST

![Hypercodemap](<./screenshots/Screenshot 2026-03-21 at 2.30.31 PM.png>)

### Hypergraph attraction -- pulls related

![Hypercodemap](<./screenshots/Screenshot 2026-03-21 at 2.33.02 PM.png>)


## Philosophy

The source code is compiled into an AST, ultimately integrated into a hypergraph.

The hypergraph contains all knowledge of the sourcecode, AI driven.

It doesn't have to be AI driven, but as a human it's too long to do... AI already encoded most of the hard comprehension (NLP). Adapting to code is the next step.

Cool part about the hypergraph is that it can be rewritten in realtime as code changes. You'll see nodes getting pulled together and other's pushed away. New nodes created constantly while building a new feature.

`The source code is "alive" ?`

Add in runtime execution visualization with this and it could end up making something beautifully artistic.

Or add in the ability to retroactively improve itself, not just runtime vars, but dynamically writing new functions. What is the role of the human in this exploration? Where do AIs get lost in their ability to "write new code". To go further.

## How to use it?

It's primarily a source code navigation system. You can analyze how dependencies are created between function calls. Who uses those dependencies.

The primary tool is **"Gather"** -- `Pull` nodes towards selected node. 

The secondary tool is **"Rewind"** -- `X` time goes backwards [#time](#Time).

There are many more [controls](./controls.md). You'll find your own style of navigation eventually I'm sure.

## Time

At the moment "time" really just means nodes will return to a state. In most cases nodes return to T0, when the depgraph is initialized. However, there are nuances to what it means to be at T0. Mostly it's when the depgraph is recomputed, eventually will be realtime with constant updates. Then the real question will be HOW OFTEN. Funny when talking about time.

Anyways so time is just a timeline, currently linear, of the source code. This is **`git`**. Another layer of the hypergraph to add !

## AI Use

Source code already has a structure. AST is a different tool than NLP. AST is the concrete guide. AST now needs contextual awareness of the meta purpose of the AST. Ex: what does it mean to build a turret to protect the NPCs. Humans and AI understand what that story means. Allegedly. And if it doesn't then it's really good at creating categories, and putting words to what were seeing in code, when we tell it what to do and it understands and it **just does it**

I think where AI gets lost its in really complex stuff, like making the depgraph, had to restore and try again (x10). 

## Navigator

I think it's interesting to see how systems can be explored. We have maps for a lot of things... But we're at a point where those things are maybe too complicated to describe easily with paragraphs. Creating visual clusters of hierarchical information. Displayed in a dynamic way, such that all your curiosities are explored. 

How a game works. That was the primary purpose. To explore the code a different way than linearly. Because ultimately code is NOT LINEAR. Yet we continue to read it linearly. It is a hypergraph and navigating it is required due to information overload. AI may do this by themselves within their embedding/context.

## Codemap cluster boundaries

![Hypercodemap](<./screenshots/Screenshot 2026-03-21 at 3.08.07 PM.png>)

## Experiment record #1 -- Inspecting depgraph for the first time

The AI has really outdone itself again. Although, I'm glad to be a human because the importance it gives to somethings is off. At least from the perspective of what i'm looking for right now.

But, NLP allows for FAST and easy edits to what the AI thinks is important. It's markdown... Or could be done in the hypergraph directly.

The controls didn't work properly... I asked Claude, via a vague prompt to take a look. But he got lost in the controls code, looking at input area preventDefaults... The issue was in locked/unlocked node within the Gather/Pull functions...

New prompt asks Claude to look at our memory `./runtime/depgraph.md` for AST functions that may be of interest before writing code. He keeps using a bunch of different tools too to read files before working... is it cheaper? Without restricting Claude either in its navigation of the source code.

I navigated the hypergraph to try to find the issue. It's a bit clunky, there are some unclear controls. But ultimately I found (easily) Gather/Pull -> "startSpacePull".

I also quite like the "control-click" to dismiss things that are clearly not related (like all the rendering stuff...)

Using the side-panel of nodes to see who called the function. Or who it calls. Seems like "PULL" control doesn't take into account for the caller edges. Seems like the hypergraph is missing those dependencies.

New edge types reveals the inner structure of this repo.

![edges for Callee Caller Shared State](./screenshots/callee_caller_state_edges.png)
