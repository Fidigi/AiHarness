"""Read Chromium's native chrome through AT-SPI, never the web document tree."""
import json
import pyatspi

queue = [pyatspi.Registry.getDesktop(0)]
visited = 0
zoom = None
menu = False
while queue and visited < 1500:
    node = queue.pop(0)
    visited += 1
    try:
        role, name = node.getRoleName(), node.name or ""
        if role == "document web":
            continue
        if role == "push button" and name == "Zoom: 200%":
            zoom = name
        if role == "menu item" and name == "Zoom" and node.getState().contains(pyatspi.STATE_SHOWING):
            menu = True
        queue.extend(node)
    except RuntimeError:
        continue
print(json.dumps({"nativeZoom": zoom, "nativeZoomMenu": menu, "visited": visited}))
