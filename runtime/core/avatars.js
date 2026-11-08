/* Player pictures: animal faces a pre-reader tells apart by shape and color alone.
 * Plain SVG shapes, so they need no emoji font and stay crisp on any screen. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldAvatars = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ink = '#2b1b33', cream = '#fff6ec', blush = '<ellipse cx="X" cy="Y" rx="6.5" ry="4" fill="#ff7f9d" opacity=".55"/>';
  const cheeks = (y, spread = 19) => blush.replace('X', 50 - spread).replace('Y', y) + blush.replace('X', 50 + spread).replace('Y', y);
  const eye = (x, y, r = 4.6) => '<ellipse cx="' + x + '" cy="' + y + '" rx="' + r + '" ry="' + (r * 1.15).toFixed(2) + '" fill="' + ink + '"/><circle cx="' + (x + r * 0.35).toFixed(2) + '" cy="' + (y - r * 0.4).toFixed(2) + '" r="' + (r * 0.38).toFixed(2) + '" fill="#fff"/>';
  const eyes = (y, spread = 12, r) => eye(50 - spread, y, r) + eye(50 + spread, y, r);
  const smile = (y, w = 5, color = ink) => '<path d="M' + (50 - w) + ' ' + y + 'q' + w / 2 + ' 3.4 ' + w + ' 0q' + w / 2 + ' 3.4 ' + w + ' 0" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
  const faces = {
    fox: {name: 'Fox', color: '#3ec1c9', art:
      '<path d="M17 47 23 11 47 31Z" fill="#e8692a"/><path d="M83 47 77 11 53 31Z" fill="#e8692a"/>' +
      '<path d="M24 36 26 19 38 30Z" fill="' + ink + '" opacity=".75"/><path d="M76 36 74 19 62 30Z" fill="' + ink + '" opacity=".75"/>' +
      '<path d="M50 87C35 87 15 74 14 53 13 37 29 27 50 27S87 37 86 53C85 74 65 87 50 87Z" fill="#f5883a"/>' +
      '<path d="M50 87C41 87 25 79 19 61 29 64 41 62 50 71 59 62 71 64 81 61 75 79 59 87 50 87Z" fill="' + cream + '"/>' +
      eyes(52, 14) + '<ellipse cx="50" cy="73" rx="5.4" ry="3.9" fill="' + ink + '"/>' + smile(78, 4.5)},
    frog: {name: 'Frog', color: '#ff8cc6', art:
      '<circle cx="31" cy="38" r="15" fill="#4fbf63"/><circle cx="69" cy="38" r="15" fill="#4fbf63"/>' +
      '<ellipse cx="50" cy="62" rx="37" ry="25" fill="#4fbf63"/><ellipse cx="50" cy="71" rx="26" ry="12" fill="#7fdc84"/>' +
      '<circle cx="31" cy="37" r="10" fill="' + cream + '"/><circle cx="69" cy="37" r="10" fill="' + cream + '"/>' + eyes(38, 19, 5) +
      '<path d="M33 63q17 13 34 0" fill="none" stroke="#1f6b35" stroke-width="3" stroke-linecap="round"/>' + cheeks(62, 25)},
    bear: {name: 'Bear', color: '#ffd23f', art:
      '<circle cx="25" cy="30" r="13" fill="#9a5f33"/><circle cx="75" cy="30" r="13" fill="#9a5f33"/>' +
      '<circle cx="25" cy="30" r="6.5" fill="#d99a63"/><circle cx="75" cy="30" r="6.5" fill="#d99a63"/>' +
      '<circle cx="50" cy="56" r="33" fill="#ab6c3b"/><ellipse cx="50" cy="69" rx="16" ry="12" fill="#ecc596"/>' +
      eyes(50, 13) + '<ellipse cx="50" cy="64" rx="6.5" ry="4.6" fill="' + ink + '"/>' + smile(70, 4.5) + cheeks(62, 23)},
    bunny: {name: 'Bunny', color: '#6aa6ff', art:
      '<ellipse cx="37" cy="27" rx="9.5" ry="23" transform="rotate(-9 37 27)" fill="' + cream + '"/><ellipse cx="63" cy="27" rx="9.5" ry="23" transform="rotate(9 63 27)" fill="' + cream + '"/>' +
      '<ellipse cx="37" cy="28" rx="4.6" ry="16" transform="rotate(-9 37 28)" fill="#ffb3c7"/><ellipse cx="63" cy="28" rx="4.6" ry="16" transform="rotate(9 63 28)" fill="#ffb3c7"/>' +
      '<circle cx="50" cy="63" r="29" fill="' + cream + '"/>' + eyes(59, 11) +
      '<path d="M46 67h8l-4 4.4Z" fill="#ff7f9d" stroke="#ff7f9d" stroke-width="1.6" stroke-linejoin="round"/>' + smile(72, 4) + cheeks(68, 19)},
    panda: {name: 'Panda', color: '#5bcf88', art:
      '<circle cx="25" cy="31" r="12.5" fill="' + ink + '"/><circle cx="75" cy="31" r="12.5" fill="' + ink + '"/>' +
      '<circle cx="50" cy="56" r="33" fill="' + cream + '"/>' +
      '<ellipse cx="37" cy="53" rx="9" ry="11.5" transform="rotate(28 37 53)" fill="' + ink + '"/><ellipse cx="63" cy="53" rx="9" ry="11.5" transform="rotate(-28 63 53)" fill="' + ink + '"/>' +
      '<circle cx="38" cy="52" r="3.6" fill="#fff"/><circle cx="62" cy="52" r="3.6" fill="#fff"/>' +
      '<ellipse cx="50" cy="66" rx="5.6" ry="4" fill="' + ink + '"/>' + smile(71, 4.2) + cheeks(66, 23)},
    owl: {name: 'Owl', color: '#ffa53f', art:
      '<path d="M16 41 22 12 41 27Q50 24 59 27L78 12 84 41Q88 74 50 89 12 74 16 41Z" fill="#7a58c6"/>' +
      '<path d="M30 74q20 14 40 0" fill="none" stroke="#a487e6" stroke-width="3" stroke-linecap="round"/>' +
      '<circle cx="36" cy="47" r="14" fill="' + cream + '"/><circle cx="64" cy="47" r="14" fill="' + cream + '"/>' + eyes(48, 14, 6.4) +
      '<path d="M44 59h12l-6 9Z" fill="#ffb02e" stroke="#ffb02e" stroke-width="2" stroke-linejoin="round"/>'},
    cat: {name: 'Cat', color: '#ff7a6b', art:
      '<path d="M16 50 22 13 46 31Z" fill="#8c86a6"/><path d="M84 50 78 13 54 31Z" fill="#8c86a6"/>' +
      '<path d="M23 38 25 21 37 31Z" fill="#ffb3c7"/><path d="M77 38 75 21 63 31Z" fill="#ffb3c7"/>' +
      '<ellipse cx="50" cy="58" rx="35" ry="29" fill="#a29dbb"/>' + eyes(54, 13) +
      '<path d="M46 63h8l-4 4Z" fill="#ff7f9d" stroke="#ff7f9d" stroke-width="1.6" stroke-linejoin="round"/>' + smile(68, 4) +
      '<path d="M28 63 11 60M28 68 12 70M72 63 89 60M72 68 88 70" stroke="' + cream + '" stroke-width="2.2" stroke-linecap="round" opacity=".85"/>'},
    chick: {name: 'Chick', color: '#a68bff', art:
      '<path d="M50 30C46 22 48 15 54 12 52 19 55 24 58 27Z" fill="#ffc21a"/><path d="M47 30C40 25 39 19 42 15 43 21 47 25 51 28Z" fill="#ffc21a"/>' +
      '<circle cx="50" cy="59" r="32" fill="#ffd84a"/><ellipse cx="50" cy="73" rx="20" ry="11" fill="#ffe789"/>' + eyes(54, 13) +
      '<path d="M42 64 50 58 58 64 50 70Z" fill="#ff9330" stroke="#ff9330" stroke-width="2" stroke-linejoin="round"/>' + cheeks(66, 22)}
  };
  const ids = Object.freeze(Object.keys(faces));
  function known(id) { if (!Object.prototype.hasOwnProperty.call(faces, id)) throw Error('Unknown picture'); return faces[id]; }
  // A soft rim and top light make every face read as one family of round tokens.
  function svg(id) {
    const face = known(id);
    return '<svg class="avatar-art" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="50" fill="' + face.color + '"/>' +
      '<path d="M50 4a46 46 0 0 0-41 25" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".35"/>' + face.art +
      '<circle cx="50" cy="50" r="48.5" fill="none" stroke="#000" stroke-width="3" opacity=".12"/></svg>';
  }
  return {ids, svg, name: id => known(id).name, color: id => known(id).color};
});
