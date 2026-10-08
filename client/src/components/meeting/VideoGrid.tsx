"use client";

import { useRef } from "react";
import { useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useElementSize } from "./hooks";
import { VideoTile } from "./VideoTile";

const GAP = 4; // matches gap-1
const MIN_TILE_HEIGHT = 90;

interface Layout {
  width: number;
  height: number;
  scroll: boolean;
}

/**
 * Picks the column count that gives the largest tiles for `count` tiles in a box.
 * A lone participant on desktop gets the biggest 16:9 tile (letterboxed in black, as in
 * Zoom); on a phone it fills the whole stage. Phones get at most 2 columns and slightly
 * taller tiles; if tiles would get too small, the grid keeps the max column count and
 * scrolls vertically.
 */
function galleryLayout(boxWidth: number, boxHeight: number, count: number): Layout {
  const phone = boxWidth < 640;
  if (count === 1 && phone) {
    return { width: Math.floor(boxWidth), height: Math.floor(boxHeight), scroll: false };
  }
  const aspect = phone ? 4 / 3 : 16 / 9;
  const maxCols = Math.min(count, phone ? 2 : 7);

  let best: Layout = { width: 0, height: 0, scroll: false };
  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.ceil(count / cols);
    const fitWidth = (boxWidth - GAP * (cols - 1)) / cols;
    const fitHeight = (boxHeight - GAP * (rows - 1)) / rows;
    const width = Math.min(fitWidth, fitHeight * aspect);
    if (width > best.width) best = { width, height: width / aspect, scroll: false };
  }

  if (best.height < MIN_TILE_HEIGHT) {
    const width = (boxWidth - GAP * (maxCols - 1)) / maxCols;
    best = { width, height: Math.max(width / aspect, MIN_TILE_HEIGHT), scroll: true };
  }
  return { width: Math.floor(best.width), height: Math.floor(best.height), scroll: best.scroll };
}

/** Zoom-style gallery view: one tile per participant, sized to fill the room area. */
export function VideoGrid() {
  const boxRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(boxRef);
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });
  // Self view first, like Zoom.
  const ordered = [...tracks].sort(
    (a, b) => Number(b.participant.isLocal) - Number(a.participant.isLocal),
  );

  const layout =
    size.width > 0 && size.height > 0 && ordered.length > 0
      ? galleryLayout(size.width, size.height, ordered.length)
      : null;

  // `absolute inset-0` sizes the box from <main> only, never from the tiles inside it.
  // Otherwise tile size -> box size -> measured size forms a loop and the grid grows past
  // the screen (seen after opening/closing the participants panel).
  return (
    <div
      ref={boxRef}
      className={`absolute inset-0 flex flex-wrap justify-center gap-1 overflow-x-hidden ${
        layout?.scroll ? "content-start overflow-y-auto" : "content-center overflow-y-hidden"
      }`}
    >
      {layout &&
        ordered.map((trackRef) => (
          <VideoTile
            key={`${trackRef.participant.identity}:${trackRef.source}`}
            trackRef={trackRef}
            width={layout.width}
            height={layout.height}
            rounded={ordered.length > 1}
          />
        ))}
    </div>
  );
}
