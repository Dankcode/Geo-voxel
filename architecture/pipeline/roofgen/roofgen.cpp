// roofgen: weighted straight-skeleton roof (CGAL >= 6.0 extrude_skeleton).
// stdin:  <n_contours> <max_height or 0>   then per contour: <n> followed by n lines "x y angle_deg"
//         (angle i belongs to the edge from vertex i to vertex i+1; outer contour first, any holes after)
// stdout: "V n" then n lines "x y z", "F m" then m lines "i j k"
#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Polygon_with_holes_2.h>
#include <CGAL/Surface_mesh.h>
#include <CGAL/extrude_skeleton.h>
#include <iostream>
#include <vector>
typedef CGAL::Exact_predicates_inexact_constructions_kernel K;
typedef K::FT FT; typedef K::Point_2 P2; typedef K::Point_3 P3;
typedef CGAL::Polygon_2<K> Poly; typedef CGAL::Polygon_with_holes_2<K> PwH;
typedef CGAL::Surface_mesh<P3> Mesh;
int main() {
  int nc; double hmax; if (!(std::cin >> nc >> hmax)) return 2;
  std::vector<std::vector<FT>> angles; PwH pwh;
  for (int c = 0; c < nc; ++c) {
    int n; std::cin >> n; Poly p; std::vector<FT> a;
    for (int i = 0; i < n; ++i) { double x, y, t; std::cin >> x >> y >> t; p.push_back(P2(x, y)); a.push_back(t); }
    bool want_ccw = (c == 0);
    int m = (int)a.size();
    if (p.is_counterclockwise_oriented() != want_ccw) {        // reverse, keeping each angle on its edge
      Poly q; std::vector<FT> b(m);
      for (int i = m - 1; i >= 0; --i) q.push_back(p[i]);
      for (int j = 0; j < m; ++j) b[j] = a[((m - 2 - j) % m + m) % m];   // edge q[j]->q[j+1] is our edge m-2-j reversed
      p = q; a = b;
    }
    // CGAL attaches angle i to the edge that ENDS at vertex i; ours belongs to the edge that starts there
    std::vector<FT> cg(m);
    for (int i = 0; i < m; ++i) cg[i] = a[(i - 1 + m) % m];
    a = cg;
    if (c == 0) pwh = PwH(p); else pwh.add_hole(p);
    angles.push_back(a);
  }
  Mesh m; bool ok;
  if (hmax > 0) ok = CGAL::extrude_skeleton(pwh, m, CGAL::parameters::angles(angles).maximum_height(FT(hmax)));
  else ok = CGAL::extrude_skeleton(pwh, m, CGAL::parameters::angles(angles));
  if (!ok) { std::cerr << "extrusion failed\n"; return 1; }
  std::cout.precision(10);
  std::cout << "V " << m.number_of_vertices() << "\n";
  for (auto v : m.vertices()) { const P3& p = m.point(v); std::cout << p.x() << " " << p.y() << " " << p.z() << "\n"; }
  std::vector<std::vector<int>> F;
  for (auto f : m.faces()) { std::vector<int> ids; for (auto v : CGAL::vertices_around_face(m.halfedge(f), m)) ids.push_back((int)v); F.push_back(ids); }
  std::cout << "F " << F.size() << "\n";
  for (auto& ids : F) { for (size_t i = 0; i < ids.size(); ++i) std::cout << ids[i] << (i + 1 < ids.size() ? " " : "\n"); }
  return 0;
}
