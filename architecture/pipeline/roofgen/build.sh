#!/usr/bin/env bash
# Build the two roof tools (CGAL >= 6.0 weighted straight skeleton) next to this script.
# Needs a C++17 compiler and CGAL, GMP and MPFR headers/libraries (architecture/environment.yml provides them).
set -euo pipefail
cd "$(dirname "$0")"
PREFIX="${CONDA_PREFIX:-/usr}"
for t in roofgen roofgen_exact; do
  ${CXX:-g++} -O2 -std=c++17 -DNDEBUG -I"$PREFIX/include" "$t.cpp" -o "$t" -L"$PREFIX/lib" -Wl,-rpath,"$PREFIX/lib" -lgmp -lmpfr
done
echo "built: $(pwd)/roofgen $(pwd)/roofgen_exact"
