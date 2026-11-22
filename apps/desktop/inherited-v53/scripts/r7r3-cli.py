"""Python entry to the same bounded Node command contract, UTF-8 JSON preserved."""
import pathlib, subprocess, sys
root=pathlib.Path(__file__).absolute().parent.parent
node=root/'node.exe'
command=[str(node) if node.is_file() else 'node',str(root/'scripts/r7r3-cli.cjs'),*sys.argv[1:]]
sys.exit(subprocess.call(command))
