# Controls

## Select

- **Click** a node: select it, show info panel
- **Shift+Click** — *Pin*: toggle multi-select and auto-lock the node in place
- **Shift+Click again**: deselect and unlock

## Drag

- **Click+Drag** — *Move*: move a node freely (no pull-in effect)
- Dragged nodes become "sticky" and keep their position
- **Shift+Drag** a selected node — *Group Move*: drag all selected nodes together
- **Shift+Drag** an unselected node: ignored (won't displace it)

## Gravity Well

- **Click cluster label + Shift + Hold Space** — *Cluster Blackhole*: pull all cluster nodes towards cluster centroid, collapses cluster
- **Control-click cluster label** - *Cluster Shrink*: all nodes and cluster boundary shrinks centered on its centroid


## Rewind

- **Hold X** — *Rewind*: all unlocked nodes smoothly return to their original layout (T0). Saves a time point on release.
- **Click+Hold a node, then X** — *Snap Back*: only that held node returns to T0 (fast)
- **Shift+X held, then click nodes** — *Dismiss*: each clicked node snaps back to T0 individually, similar to control-click
- **Control+Click node** - *Dismiss*: the clicked node snaps back to T0, similar to shift-x
- Release X or mouse at any time to stop — nodes stay where they are
- Locked nodes are not affected by rewind

## Time Travel

Every interaction that moves nodes (drag, rewind, gravity well, gather, etc.) saves a **time point** — a snapshot of where all nodes are. These time points form a linear history that you can navigate.

- **Hold Z** — *Reverse*: smoothly animate backwards through time points, rewinding through your arrangement history one step at a time. Saves a new time point on release.
- **Alt+Left / Alt+Right** — *Step*: jump one time point forward or backward
- Rapidly alternating Alt+Left/Right enters **comparison mode**, overlaying two arrangements

Z is the temporal opposite of X: X rewinds node positions toward the original layout (T0), while Z rewinds through your history of arrangements.

## Gather

- **Hold Space** (with 2+ selected nodes) — *Quick Gather*: pull selected nodes toward their centroid
- **Click node + Hold space** - *Stranger Gather*: pull unselected neighbors towards clicked node (works whether the clicked node is selected or not)
- **Click node + Shift + Hold Space** (with 2+ selected nodes) - *Group Gather*: pull selected nodes towards clicked node
- **Click cluster label + Hold Space** — *Extra-Cluster Gather*: pull all clusters connected (via meta-edges) toward the clicked cluster. Uninvolved clusters are gently repulsed outward. Release Space to stop.
- **Shift+Drag** — *Group Move*: drag all selected nodes together (see Drag section)
- Locked nodes are not affected by gather/group move

## Trace

Trace propagates a visual BFS wave through the on-screen portion of the hypergraph, following enabled edge layers. Only nodes currently visible on screen are traced (saves CPU).

- **Tap T** -- *Flash*: instantly traces the full reachable graph from the selected node (or a random on-screen node) with a fast staggered animation
- **Hold T** -- *Trace*: BFS propagates one hop at a time. Speed starts at 1s per edge and ramps up linearly (down to ~0.33x) the longer you hold. Speed is adjustable via the T slider in the toolbar.
- **Hold T+B** -- *Trace Back*: hold both T and B together to trace backward edges only (reverse of directed edge direction). Bidirectional edges are ignored. Undirected edges are skipped. Releasing B pauses the trace (visuals remain). Pressing B again restarts the backward trace.
- **Hold T+F** -- *Trace Forward*: hold both T and F together to trace forward edges only (source to target on directed edges). Releasing F pauses the trace. Pressing F again restarts the forward trace.
- **H** (during trace) -- *Hold*: locks the trace visuals in place. After pressing H, you can release T and the trace remains visible. Press **H** again or **Escape** to clear the held trace. Pressing **T** again also clears the held trace and starts a new one.
- While a trace is held, **B** and **F** resume navigation from the current wavefront in that direction -- T does not need to be held. Releasing B/F pauses again.
- Releasing T (without H) stops the trace entirely and clears visuals.

Directed edge layers follow their arrow direction. Undirected edge layers trace both connected nodes (except in backward mode, where they are skipped).

The trace starts from the currently selected/clicked node. If no node is selected, a random on-screen node is chosen.

**Show edges on trace** (checkbox, on by default): when edges are toggled off, traced edges are still revealed during the trace. Traced edges use their layer's own color at full opacity, then hide again when the trace ends.

## User Clusters

- **Enter** (with 2+ selected nodes): create a user-defined cluster from the selected nodes
- Sends the selection to Claude (via the node server) to generate a meaningful cluster name
- User clusters are shown as dashed hulls and appear in the legend
- Click a user cluster in the legend to re-select its nodes
- Nodes can belong to multiple user clusters
- User clusters persist across resets (stored in localStorage)

## Lock / Unlock

- **Lock button** (toolbar): locks currently selected nodes in place
- Locked nodes are pinned — they resist rewind, gather, and gravity well from unselected nodes
- Shift+clicked (pinned) nodes are auto-locked

## Keyboard Summary

| Key | Action |
|-----|--------|
| **Click** | Select |
| **Shift+Click** | Pin (multi-select + lock) |
| **Shift+Drag** | Group move selected nodes |
| **Hold X** | Rewind to T0 |
| **Shift+X + Click** | Dismiss node to T0 |
| **Hold Z** | Time-travel backwards through history |
| **Tap T** | Flash-trace through visible graph |
| **Hold T** | Trace BFS propagation (speeds up over time) |
| **T+B** | Trace backward edges only |
| **T+F** | Trace forward edges only |
| **T+H** | Hold trace visuals (persist after T release) |
| **H** / **Escape** | Clear held trace |
| **Hold Space** | Gather selected nodes (to centroid) |
| **Click node + Space** | Gather unselected neighbors toward node |
| **Click cluster label + Space** | Gather connected clusters toward label |
| **Click cluster label + Shift+Space** | Gather cluster nodes toward centroid |
| **Click node + Shift+Space** | Gather selected nodes toward node |
| **Space** (nothing selected) | Unlock all |
| **Enter** | Create user cluster from selection |
| **Alt+Arrow** | Step through time points |
| **Escape** | Close panel / clear selection |

## Toolbar Toggles

- **Labels**: show/hide node labels
- **Clusters**: show/hide cluster hulls
- **Edges**: show/hide edges (auto-appear when zoomed in past 2.5x)
- **Live**: enable/disable live reload

## Zoom

- Scroll to zoom in/out
- Labels appear as nodes get large enough on screen
- Edges become visible automatically at high zoom levels even if toggled off
- Cluster labels scale inversely with zoom
