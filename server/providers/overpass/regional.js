/**
 * Regional extracts are not full-planet mirrors. Only the deliberately small
 * road-query grammar below can establish completeness; unfamiliar QL stays on
 * global sources. Never infer coverage from the presence of just one bbox.
 */
function endpoint(value, name) {
  if (
    typeof value !== 'string' ||
    !/^https?:\/\//i.test(value) ||
    value !== value.trim() ||
    /[\s\\?#]/.test(value)
  )
    throw new Error(`${name}: invalid endpoint URL`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name}: invalid endpoint URL`);
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `${name}: expected http(s) URL without credentials, query or fragment`,
    );
  }
  return url.href;
}

function loadOverpassSourceConfig(env = process.env, defaults = []) {
  let upstreams = defaults;
  if (env.OVERPASS_UPSTREAMS_JSON !== undefined) {
    try {
      upstreams = JSON.parse(env.OVERPASS_UPSTREAMS_JSON);
    } catch {
      throw new Error('OVERPASS_UPSTREAMS_JSON: expected JSON array');
    }
    if (!Array.isArray(upstreams) || !upstreams.length) {
      throw new Error('OVERPASS_UPSTREAMS_JSON: expected nonempty JSON array');
    }
    upstreams = upstreams.map((url) =>
      endpoint(url, 'OVERPASS_UPSTREAMS_JSON'),
    );
  }
  const url = env.OVERPASS_REGIONAL_URL;
  const rawBounds = env.OVERPASS_REGIONAL_BOUNDS;
  if (url === undefined && rawBounds === undefined)
    return { upstreams, regional: null };
  if (!url || !rawBounds)
    throw new Error(
      'OVERPASS_REGIONAL_URL and OVERPASS_REGIONAL_BOUNDS must be set together',
    );
  const parts = rawBounds.split(',');
  const bounds = parts.map(Number);
  const [south, west, north, east] = bounds;
  if (
    parts.length !== 4 ||
    parts.some((p) => !/^-?\d+(?:\.\d+)?$/.test(p.trim())) ||
    !bounds.every(Number.isFinite) ||
    south < -90 ||
    north > 90 ||
    west < -180 ||
    east > 180 ||
    south >= north ||
    west >= east
  ) {
    throw new Error(
      'OVERPASS_REGIONAL_BOUNDS: expected south,west,north,east without antimeridian crossing',
    );
  }
  return {
    upstreams,
    regional: { url: endpoint(url, 'OVERPASS_REGIONAL_URL'), bounds },
  };
}

function isRegionalRoadQuery(body, bounds) {
  const params = new URLSearchParams(body);
  const queries = params.getAll('data');
  if (queries.length !== 1 || [...params.keys()].some((key) => key !== 'data'))
    return false;
  // Anchor the entire grammar, including quoted tags. No comments, escapes,
  // recursion, assignments, directives or extra selectors can hide a global read.
  const match = queries[0].match(
    /^\s*\[out:json\]\s*(?:\[timeout:\d+\]\s*)?;\s*\(\s*((?:way\s*\[\s*"highway"\s*(?:[=~]\s*"[a-zA-Z0-9_|^$().?+* -]+")?\s*\]\s*\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)\s*;\s*)+)\)\s*;\s*out\s+geom(?:\s+qt)?\s*;\s*$/,
  );
  if (!match) return false;
  const boxes = [
    ...match[1].matchAll(
      /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
    ),
  ];
  return (
    boxes.length > 0 &&
    boxes.every((box) => {
      const [s, w, n, e] = box.slice(1).map(Number);
      return (
        s < n &&
        w < e &&
        s >= bounds[0] &&
        w >= bounds[1] &&
        n <= bounds[2] &&
        e <= bounds[3]
      );
    })
  );
}

function overpassEndpointsForBody(body, config) {
  return config.regional && isRegionalRoadQuery(body, config.regional.bounds)
    ? [
        config.regional.url,
        ...config.upstreams.filter((url) => url !== config.regional.url),
      ]
    : config.upstreams;
}

export {
  loadOverpassSourceConfig,
  isRegionalRoadQuery,
  overpassEndpointsForBody,
};
