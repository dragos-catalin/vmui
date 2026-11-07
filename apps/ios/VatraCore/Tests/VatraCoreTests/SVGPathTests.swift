import XCTest

@testable import VatraCore

final class SVGPathTests: XCTestCase {
  func testParsesEveryMarkPath() {
    for g in [VatraMarks.master, VatraMarks.small, VatraMarks.micro] {
      for d in [g.roof, g.walls, g.flame] + (g.core.map { [$0] } ?? []) {
        let ops = SVGPath.parse(d)
        XCTAssertFalse(ops.isEmpty, d)
        guard case .move = ops.first else { return XCTFail("no M in \(d)") }
      }
    }
  }

  func testHorizontalAndVerticalKeepTheOtherAxis() {
    XCTAssertEqual(SVGPath.parse("M1 2 H5 V7 Z"), [.move(1, 2), .line(5, 2), .line(5, 7), .close])
  }

  func testNegativeNumbersAndExponentsSplitCorrectly() {
    XCTAssertEqual(SVGPath.parse("M0-1.5L2e1 -3"), [.move(0, -1.5), .line(20, -3)])
  }
}
