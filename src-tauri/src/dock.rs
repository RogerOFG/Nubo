use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    Right,
    Bottom,
    #[default]
    #[serde(other)]
    Top,
}

impl Edge {
    pub fn lateral(self) -> bool {
        matches!(self, Self::Left | Self::Right)
    }
}

/// An anchor along the usable edge of the selected display, from 0 to 1.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Dock {
    pub edge: Edge,
    pub offset: f64,
}

impl Default for Dock {
    fn default() -> Self {
        Self {
            edge: Edge::Top,
            offset: 0.5,
        }
    }
}

impl Dock {
    pub fn offset(self) -> f64 {
        if self.offset.is_finite() {
            self.offset.clamp(0.0, 1.0)
        } else {
            0.5
        }
    }

    pub fn toward_center(self, progress: f64) -> Self {
        let t = progress.clamp(0.0, 1.0);
        let eased = t * t * (3.0 - 2.0 * t);
        let start = self.offset();
        Self { offset: start + (0.5 - start) * eased, ..self }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl WorkArea {
    /// The window is inset from the actual taskbar. Its anchor stays fixed
    /// as the island grows and shrinks, unless the larger panel needs clamping.
    pub fn place(self, dock: Dock, w: u32, h: u32) -> (i32, i32) {
        let along = |origin: i32, available: u32, size: u32| {
            let start = (f64::from(available) * dock.offset() - f64::from(size) / 2.0).round();
            origin + start.clamp(0.0, f64::from(available.saturating_sub(size))) as i32
        };
        match dock.edge {
            Edge::Top => (along(self.x, self.w, w), self.y),
            Edge::Bottom => (
                along(self.x, self.w, w),
                self.y + self.h.saturating_sub(h) as i32,
            ),
            Edge::Left => (self.x, along(self.y, self.h, h)),
            Edge::Right => (
                self.x + self.w.saturating_sub(w) as i32,
                along(self.y, self.h, h),
            ),
        }
    }

    /// Pull on the edge the island is approaching. Keep its centre along that
    /// edge, so grabbing a tall panel by its header cannot move it up a row.
    pub fn magnet(
        self,
        position: (f64, f64),
        size: (f64, f64),
        scale: f64,
        previous: Option<Edge>,
    ) -> Option<(Dock, f64)> {
        let (x, y) = (position.0 - f64::from(self.x), position.1 - f64::from(self.y));
        let (w, h) = (f64::from(self.w), f64::from(self.h));
        if w == 0.0 || h == 0.0 { return None; }
        let gaps = [
            (Edge::Top, y),
            (Edge::Bottom, h - y - size.1),
            (Edge::Left, x),
            (Edge::Right, w - x - size.0),
        ].map(|(edge, gap)| (edge, gap.max(0.0)));
        let &(nearest, gap) = gaps.iter().min_by(|a, b| a.1.total_cmp(&b.1))?;
        let (edge, gap) = gaps.into_iter().find(|(edge, distance)| {
            Some(*edge) == previous && *distance <= gap + 10.0 * scale && *distance < 64.0 * scale
        }).unwrap_or((nearest, gap));
        let pull = ((64.0 - gap / scale) / 44.0).clamp(0.0, 1.0);
        if pull == 0.0 { return None; }
        let offset = if edge.lateral() { (y + size.1 / 2.0) / h } else { (x + size.0 / 2.0) / w };
        let strength = pull * pull * (3.0 - 2.0 * pull);
        Some((Dock { edge, offset: offset.clamp(0.0, 1.0) }, strength))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: WorkArea = WorkArea {
        x: -1500,
        y: -500,
        w: 1500,
        h: 900,
    };

    #[test]
    fn recentering_slides_along_the_current_edge_without_changing_it() {
        for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
            let start = Dock { edge, offset: 0.2 };
            let middle = start.toward_center(0.5);
            let end = start.toward_center(1.0);
            assert_eq!(end, Dock { edge, offset: 0.5 });
            assert!(middle.offset > start.offset && middle.offset < end.offset);
            let (x0, y0) = AREA.place(start, 300, 180);
            let (x1, y1) = AREA.place(end, 300, 180);
            if edge.lateral() { assert_eq!(x0, x1); assert_ne!(y0, y1); }
            else { assert_eq!(y0, y1); assert_ne!(x0, x1); }
        }
    }

    #[test]
    fn an_edge_uses_the_work_area_and_the_anchor_survives_a_resize() {
        let right = Dock {
            edge: Edge::Right,
            offset: 0.6,
        };
        assert_eq!(AREA.place(right, 48, 132), (-48, -26));
        assert_eq!(AREA.place(right, 380, 650), (-380, -285));
        assert_eq!(
            AREA.place(
                Dock {
                    edge: Edge::Bottom,
                    offset: 0.0
                },
                720,
                320
            ),
            (-1500, 80)
        );
    }

    #[test]
    fn corners_keep_the_preview_stable_and_central_drops_cancel() {
        assert_eq!(
            AREA.magnet((-1485.0, -480.0), (380.0, 420.0), 1.5, Some(Edge::Top))
                .unwrap()
                .0.edge,
            Edge::Top
        );
        assert_eq!(
            AREA.magnet((-1485.0, -300.0), (380.0, 420.0), 1.5, Some(Edge::Top))
                .unwrap()
                .0.edge,
            Edge::Left
        );
        assert!(AREA.magnet((-750.0, -280.0), (380.0, 420.0), 1.0, None).is_none());
    }

    #[test]
    fn a_side_drag_preserves_the_grabbed_panel_height_and_detaches_gradually() {
        let (dock, strength) = AREA.magnet((-1500.0, -200.0), (380.0, 420.0), 1.0, Some(Edge::Left)).unwrap();
        assert_eq!(dock.edge, Edge::Left);
        assert_eq!(AREA.place(dock, 380, 420), (-1500, -200));
        assert_eq!(strength, 1.0);
        let (_, strength) = AREA.magnet((-1460.0, -200.0), (380.0, 420.0), 1.0, Some(Edge::Left)).unwrap();
        assert!((0.0..1.0).contains(&strength));
        assert!(AREA.magnet((-1400.0, -200.0), (380.0, 420.0), 1.0, Some(Edge::Left)).is_none());
    }
}
