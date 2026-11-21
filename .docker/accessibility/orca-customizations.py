# Orca's supported user customization hook: logging only, no speech/event changes.
# Its default debug-file buffer otherwise hides final utterances until more input.
from orca import debug

if debug.debugFile:
    debug.debugFile.reconfigure(line_buffering=True)
