#!/usr/bin/python3
"""Retain WebKit sandbox arguments, adding only the Mali DMA allocation device."""
import os
import sys

args = sys.argv[1:]
position = args.index('--') if '--' in args else len(args)
args[position:position] = ['--dev-bind-try', '/dev/dma_heap/system', '/dev/dma_heap/system']
os.execv('/usr/bin/bwrap.cubby-original', ['bwrap', *args])
