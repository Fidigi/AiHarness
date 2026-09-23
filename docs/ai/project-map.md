# AiHarness - Project Map

## Purpose

AiHarness is an orchestration repository for several local projects. It does not
contain their source code: They are cloned into the personal folder, then exposed 
under `projects/` using symbolic links. 
`Makefile` exposes the operations and main project commands through a unified Make interface.

The functional entry points are [`Makefile`](../../Makefile). Read them before exploring a linked project.