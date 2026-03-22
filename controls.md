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

- **Force Touch** (macOS trackpad, Safari): force-press a node to pull neighbors in
- **Pointer Pressure** (Chrome/Firefox): press hard on a trackpad node to activate
- **Shift+Hold drag** (fallback for mice): starts gravity well after 0.55s delay
- Works during drag too — drag + force-press to move and attract simultaneously
- Releasing force/pressure saves the pulled arrangement
- From an **unselected** node: locked nodes are not affected
- From a **selected** node: all neighbors are pulled, including locked ones

## Rewind

- **Hold X** — *Rewind*: all unlocked nodes smoothly return to their original layout (T0). Saves a time step on release.
- **Click+Hold a node, then X** — *Snap Back*: only that held node returns to T0 (fast)
- **Shift+X held, then click nodes** — *Dismiss*: each clicked node snaps back to T0 individually
- **Control+Click node** - *Dismiss*: the clicked node snaps back to T0
- Release X or mouse at any time to stop — nodes stay where they are
- Locked nodes are not affected by rewind

## Gather

- **Hold Space** (with 2+ selected nodes) — *Gather*: pull selected nodes toward their centroid
- **Shift+Drag** — *Group Move*: drag all selected nodes together (see Drag section)
- Locked nodes are not affected by gather/group move

## Lock / Unlock

- **Lock button** (toolbar): locks currently selected nodes in place
- **Space** (no selected nodes): unlock all locked nodes
- Locked nodes are pinned — they resist rewind, gather, and gravity well from unselected nodes
- Shift+clicked (pinned) nodes are auto-locked

## Time Steps

- **X release** saves current state as a time step
- **Alt+Left / Alt+Right** — *Time Travel*: navigate arrangement history

## Keyboard Summary

| Key | Action |
|-----|--------|
| **Click** | Select |
| **Shift+Click** | Pin (multi-select + lock) |
| **Shift+Drag** | Group move selected nodes |
| **Hold X** | Rewind to T0 |
| **Shift+X + Click** | Dismiss node to T0 |
| **Hold Space** | Gather selected nodes |
| **Space** (nothing selected) | Unlock all |
| **Alt+Arrow** | Time travel |
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
