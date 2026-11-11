// Well-known binary -> GeoJSON geometry, for the footprints in the GeoParquet
// files (2D; ISO and EWKB-style Z/M flags are skipped over).

export function wkbToGeoJSON(bytes) {
  if (!bytes || bytes.length === 0) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  function read() {
    const little = view.getUint8(offset) === 1;
    offset += 1;
    let type = view.getUint32(offset, little);
    offset += 4;
    let dims = 2;
    if (type & 0x20000000) { // EWKB SRID
      offset += 4;
    }
    if (type & 0x80000000) { dims++; }
    if (type & 0x40000000) { dims++; }
    type &= 0x0fffffff;
    if (type > 3000) { dims = 4; type -= 3000; }
    else if (type > 2000) { dims = 3; type -= 2000; }
    else if (type > 1000) { dims = 3; type -= 1000; }

    const u32 = () => { const v = view.getUint32(offset, little); offset += 4; return v; };
    const point = () => {
      const xy = [view.getFloat64(offset, little), view.getFloat64(offset + 8, little)];
      offset += 8 * dims;
      return xy;
    };
    const points = () => Array.from({ length: u32() }, point);
    const rings = () => Array.from({ length: u32() }, points);
    const parts = () => Array.from({ length: u32() }, read);

    switch (type) {
      case 1: return { type: 'Point', coordinates: point() };
      case 2: return { type: 'LineString', coordinates: points() };
      case 3: return { type: 'Polygon', coordinates: rings() };
      case 4: return { type: 'MultiPoint', coordinates: parts().map(g => g.coordinates) };
      case 5: return { type: 'MultiLineString', coordinates: parts().map(g => g.coordinates) };
      case 6: return { type: 'MultiPolygon', coordinates: parts().map(g => g.coordinates) };
      case 7: return { type: 'GeometryCollection', geometries: parts() };
      default: throw new Error(`Unsupported WKB geometry type ${type}`);
    }
  }
  return read();
}
