# Controls

## Click & Select

- **Click** a node: select it, show info panel
- **Shift+Click**: toggle multi-select (auto-locks the node in place)
- **Shift+Click again**: deselect and unlock

## Drag

- **Click+Drag**: move a node freely (no pull-in effect)
- Dragged nodes become "sticky" and keep their position

## Attractor (pull neighbors in)

- **Force Touch** (macOS trackpad, Safari): force-press a node to pull neighbors in
- **Pointer Pressure** (Chrome/Firefox): press hard on a trackpad node to activate
- **Shift+Hold drag** (fallback for mice): starts attractor after 0.55s delay
- Works during drag too — drag + force-press to move and attract simultaneously
- Releasing force/pressure locks the pulled arrangement

## X Key — Relaxation / Dismiss

- **Hold X**: all unlocked nodes smoothly return to their original layout positions (3s ramp)
- **Click+Hold a node, then X**: only that node returns to T0 (0.5s, fast)
- **Shift+X held, then click nodes**: dismiss each clicked node to T0 individually
- Release X or mouse at any time to stop — nodes stay where they are
- Locked nodes are not affected by bulk X relaxation

## Lock / Unlock

- **Lock button** (toolbar): locks currently selected nodes in place
- **Space**: unlock all locked nodes
- Locked nodes are pinned — they won't move during X relaxation
- Shift+clicked nodes are auto-locked

## Keyboard

- **Space**: unlock all locked nodes
- **Alt+Left / Alt+Right**: navigate arrangement history
- **Escape**: close info panel, exit comparison mode, or clear selection

## Toolbar Toggles

- **Labels**: show/hide node labels
- **Clusters**: show/hide cluster hulls
- **Edges**: show/hide edges (edges auto-appear when zoomed in past 2.5x)
- **Live**: enable/disable live reload

## Zoom

- Scroll to zoom in/out
- Labels appear as nodes get large enough on screen
- Edges become visible automatically at high zoom levels even if toggled off
- Cluster labels scale inversely with zoom
