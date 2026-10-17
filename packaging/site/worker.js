/**
 * The Worker in front of the landing page.
 *
 * The site is static - one HTML file, one stylesheet, one icon - so the whole
 * job is handing the request to the asset store. It exists because the hosting
 * needs a fetch handler, not because anything has to be computed.
 *
 * If a page is ever added that needs more than files (a download counter, a
 * "latest release" lookup), this is where that goes, and the rule AirChat keeps
 * everywhere else applies here too: say what is true rather than what sounds
 * good.
 */
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
