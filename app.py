"""Conventional Python entry point for the Jump-managed web preview."""
import sys
from web import main

if __name__ == '__main__':
    if len(sys.argv) == 1:
        sys.argv.extend(['serve', '--bind', '0.0.0.0'])
    main()
