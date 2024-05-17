/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const MAX_SAMPLING_RATE = 10; // At a maximum we sample 1 in 10 requests

let isDebugEnabled;
export function setDebugMode(pluginOptions) {
  const { host, hostname, origin } = window.location;
  const { isProd, prodHost } = pluginOptions;
  isDebugEnabled = !(window.location.hostname.endsWith('.live')
    || (typeof isProd === 'function' && isProd())
    || (prodHost && [host, hostname, origin].includes(prodHost)));
  return isDebugEnabled;
}

export function debug(...args) {
  if (isDebugEnabled) {
    // eslint-disable-next-line no-console
    console.debug.call(this, '[experimentation]', ...args);
  }
}

export const DEFAULT_OPTIONS = {

  // Generic properties
  decorateFuntion: () => {},
  rumSamplingRate: MAX_SAMPLING_RATE, // 1 in 10 requests
  trackingFunction: window.sampleRUM,

  // Audiences related properties
  audiences: {},
  audiencesMetaTagPrefix: 'audience',
  audiencesQueryParameter: 'audience',

  // Campaigns related properties
  campaignsMetaTagPrefix: 'campaign',
  campaignsQueryParameter: 'campaign',

  // Experimentation related properties
  experimentsRoot: '/experiments',
  experimentsConfigFile: 'manifest.json',
  experimentsMetaTag: 'experiment',
  experimentsQueryParameter: 'experiment',
};

function stringToArray(str) {
  if (Array.isArray(str)) {
    return str;
  }
  return str ? str.split(/[,\n]/).filter((s) => s.trim()) : [];
}

/**
 * Sanitizes a name for use as class name.
 * @param {String} name The unsanitized name
 * @returns {String} The class name
 */
export function toClassName(name) {
  return typeof name === 'string'
    ? name.toLowerCase().replace(/[^0-9a-z]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    : '';
}

/**
 * Sanitizes a name for use as a js property name.
 * @param {String} name The unsanitized name
 * @returns {String} The camelCased name
 */
export function toCamelCase(name) {
  return toClassName(name).replace(/-([a-z])/g, (g) => g[1].toUpperCase());
}

/**
 * Retrieves the content of metadata tags.
 * @param {String} name The metadata name (or property)
 * @returns {String} The metadata value(s)
 */
export function getMetadata(name) {
  const attr = name && name.includes(':') ? 'property' : 'name';
  const meta = [...document.head.querySelectorAll(`meta[${attr}="${name}"]`)].map((m) => m.content).join(', ');
  return meta || '';
}

/**
 * Gets all the metadata elements that are in the given scope.
 * @param {String} scope The scope/prefix for the metadata
 * @returns a map of key/value pairs for the given scope
 */
export function getAllMetadata(scope) {
  const value = getMetadata(scope);
  return [...document.head.querySelectorAll(`meta[property^="${scope}:"],meta[name^="${scope}-"]`)]
    .reduce((res, meta) => {
      const key = toClassName(meta.name
        ? meta.name.substring(scope.length + 1)
        : meta.getAttribute('property').split(':')[1]);
      res[key] = meta.getAttribute('content');
      return res;
    }, value ? { value } : {});
}

/**
 * Gets all the data attributes that are in the given scope.
 * @param {String} scope The scope/prefix for the metadata
 * @returns a map of key/value pairs for the given scope
 */
function getAllDataAttributes(el, scope) {
  return el.getAttributeNames()
    .filter((attr) => attr === `data-${scope}` || attr.startsWith(`data-${scope}-`))
    .reduce((res, attr) => {
      const key = attr === `data-${scope}` ? 'value' : attr.replace(`data-${scope}-`, '');
      res[key] = el.getAttribute(attr);
      return res;
    }, {});
}

/**
 * Gets all the query parameters that are in the given scope.
 * @param {String} scope The scope/prefix for the metadata
 * @returns a map of key/value pairs for the given scope
 */
function getAllQueryParameters(scope) {
  const usp = new URLSearchParams(window.location.search);
  return [...usp.entries()]
    .filter(([param]) => param === scope || param.startsWith(`${scope}-`))
    .reduce((res, [param, value]) => {
      const key = param === scope ? 'value' : param.replace(`${scope}-`, '');
      if (res[key]) {
        res[key] = [].concat(res[key], value);
      } else {
        res[key] = value;
      }
      return res;
    }, {});
}

/**
 * Extracts the config from a block that is in the given scope.
 * @param {HTMLElement} block The block element
 * @returns a map of key/value pairs for the given scope
 */
// eslint-disable-next-line import/prefer-default-export
function getAllSectionMeta(block, scope) {
  const config = {};
  block.querySelectorAll(':scope > div').forEach((row) => {
    if (row.children) {
      const cols = [...row.children];
      if (cols[1]) {
        const col = cols[1];
        let key = toClassName(cols[0].textContent);
        if (key !== scope && !key.startsWith(`${scope}-`)) {
          return;
        }
        key = key === scope ? 'value' : key.replace(`${scope}-`, '');
        let value = '';
        if (col.querySelector('a')) {
          const as = [...col.querySelectorAll('a')];
          if (as.length === 1) {
            value = as[0].href;
          } else {
            value = as.map((a) => a.href);
          }
        } else if (col.querySelector('img')) {
          const imgs = [...col.querySelectorAll('img')];
          if (imgs.length === 1) {
            value = imgs[0].src;
          } else {
            value = imgs.map((img) => img.src);
          }
        } else if (col.querySelector('p')) {
          const ps = [...col.querySelectorAll('p')];
          if (ps.length === 1) {
            value = ps[0].textContent;
          } else {
            value = ps.map((p) => p.textContent);
          }
        } else value = row.children[1].textContent;
        config[key] = value;
      }
    }
  });
  return config;
}

/**
 * Replaces element with content from path
 * @param {String} path
 * @param {HTMLElement} el
 * @return Returns the path that was loaded or null if the loading failed
 */
async function replaceInner(path, el) {
  try {
    const resp = await fetch(path);
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.log('error loading content:', resp);
      return null;
    }
    const html = await resp.text();
    // parse with DOMParser to guarantee valid HTML, and no script execution(s)
    const dom = new DOMParser().parseFromString(html, 'text/html');
    // eslint-disable-next-line no-param-reassign
    const newEl = dom.querySelector(el.tagName === 'MAIN' ? 'main' : 'main > div');
    el.innerHTML = newEl.innerHTML;
    return path;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`error loading content: ${path}`, e);
  }
  return null;
}

/**
 * Checks if any of the configured audiences on the page can be resolved.
 * @param {String[]} pageAudiences a list of configured audiences for the page
 * @param {Object} options the plugin options
 * @returns Returns the names of the resolved audiences, or `null` if no audience is configured
 */
export async function getResolvedAudiences(pageAudiences, options) {
  if (!pageAudiences.length || !Object.keys(options.audiences).length) {
    return null;
  }
  // If we have a forced audience set in the query parameters (typically for simulation purposes)
  // we check if it is applicable
  const usp = new URLSearchParams(window.location.search);
  const forcedAudience = usp.has(options.audiencesQueryParameter)
    ? toClassName(usp.get(options.audiencesQueryParameter))
    : null;
  if (forcedAudience) {
    return pageAudiences.includes(forcedAudience) ? [forcedAudience] : [];
  }

  // Otherwise, return the list of audiences that are resolved on the page
  const results = await Promise.all(
    pageAudiences
      .map((key) => {
        if (options.audiences[key] && typeof options.audiences[key] === 'function') {
          return options.audiences[key]();
        }
        return false;
      }),
  );
  return pageAudiences.filter((_, i) => results[i]);
}

/**
 * Calculates percentage split for variants where the percentage split is not
 * explicitly configured.
 * Substracts from 100 the explicitly configured percentage splits,
 * and divides the remaining percentage, among the variants without explicit
 * percentage split configured
 * @param {Array} variant objects
 */
function inferEmptyPercentageSplits(variants) {
  const variantsWithoutPercentage = [];

  const remainingPercentage = variants.reduce((result, variant) => {
    if (!variant.percentageSplit) {
      variantsWithoutPercentage.push(variant);
    }
    const newResult = result - parseFloat(variant.percentageSplit || 0);
    return newResult;
  }, 1);
  if (variantsWithoutPercentage.length) {
    const missingPercentage = remainingPercentage / variantsWithoutPercentage.length;
    variantsWithoutPercentage.forEach((v) => {
      v.percentageSplit = missingPercentage.toFixed(2);
    });
  }
}

/**
 * Converts the experiment config to a decision policy
 * @param {Object} config The experiment config
 * @returns a decision policy for the experiment config
 */
function toDecisionPolicy(config) {
  const decisionPolicy = {
    id: 'content-experimentation-policy',
    rootDecisionNodeId: 'n1',
    decisionNodes: [{
      id: 'n1',
      type: 'EXPERIMENTATION',
      experiment: {
        id: config.id,
        identityNamespace: 'ECID',
        randomizationUnit: 'DEVICE',
        treatments: Object.entries(config.variants).map(([key, props]) => ({
          id: key,
          allocationPercentage: Number(props.percentageSplit) * 100,
        })),
      },
    }],
  };
  return decisionPolicy;
}

function getModificationsHandler(
  overrides,
  metadataToConfig,
  getExperienceUrl,
  pluginOptions,
  cb,
) {
  return async (el, metadata) => {
    const config = await metadataToConfig(pluginOptions, metadata, overrides);
    if (!config) {
      return null;
    }
    const ns = { config, el };
    const url = await getExperienceUrl(ns.config);
    let res;
    if (new URL(url, window.location.origin).pathname !== window.location.pathname) {
      res = await replaceInner(url, el);
    } else {
      res = url;
    }
    cb(el.tagName === 'MAIN' ? document.body : ns.el, ns.config, res ? url : null);
    if (res) {
      ns.servedExperience = url;
    }
    return ns;
  };
}

async function getManifestEntries(urlString) {
  try {
    const url = new URL(urlString, window.location.origin);
    const response = await fetch(url);
    const json = await response.json();
    return json.data
      .map((entry) => Object.keys(entry).reduce((res, k) => {
        res[k.toLowerCase()] = entry[k];
        return res;
      }, {}))
      .filter((entry) => !entry.page || entry.page === window.location.pathname)
      .filter((entry) => entry.selector)
      .filter((entry) => entry.url);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Cannot apply manifest: ', urlString, err);
  }
  return null;
}

function watchMutationsAndApplyFragments(ns, scope, entries, aggregator, pluginOptions, metadataToConfig, overrides, cb) {
  if (!entries.length) {
    return;
  }

  new MutationObserver(async (_, observer) => {
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      const config = await metadataToConfig(pluginOptions, entry, overrides);
      if (!config || entry.isApplied) {
        return;
      }
      const el = scope.querySelector(entry.selector);
      if (!el) {
        return;
      }
      entry.isApplied = true;
      const fragmentNS = { config, el };
      const url = config.variants[config.selectedVariant].pages[0];
      // eslint-disable-next-line no-await-in-loop
      const res = await replaceInner(url, el);
      cb(el.tagName === 'MAIN' ? document.body : fragmentNS.el, fragmentNS.config, res ? url : null);
      if (res) {
        fragmentNS.servedExperience = url;
      }
      debug('fragment', ns, fragmentNS);
      aggregator.push(fragmentNS);
    }
    if (entries.every((entry) => entry.isApplied)) {
      observer.disconnect();
    }
  }).observe(scope, { childList: true, subtree: true });
}

async function applyAllModifications(
  ns,
  paramNS,
  pluginOptions,
  metadataToConfig,
  getExperienceUrl,
  cb,
) {
  const modificationsHandler = getModificationsHandler(
    getAllQueryParameters(paramNS),
    metadataToConfig,
    getExperienceUrl,
    pluginOptions,
    cb,
  );

  const fragmentsNS = [];

  // Full-page modifications
  const pageMetadata = getAllMetadata(ns);
  const pageNS = await modificationsHandler(
    document.querySelector('main'),
    pageMetadata,
  );
  if (pageNS) {
    debug('page', ns, pageNS);
  }

  // Section-level modifications
  let sectionMetadata;
  const sectionsNS = [];
  await Promise.all([...document.querySelectorAll('.section-metadata')]
    .map(async (sm) => {
      sectionMetadata = getAllSectionMeta(sm, ns);
      const sectionNS = await modificationsHandler(
        sm.parentElement,
        sectionMetadata,
      );
      if (sectionNS) {
        debug('section', ns, sectionNS);
        sectionsNS.push(sectionNS);
      }
    }));

  if (pageMetadata.manifest) {
    let entries = await getManifestEntries(pageMetadata.manifest);
    if (ns === pluginOptions.experimentsMetaTag) {
      entries = Object.values(Object.groupBy(entries, ({ experiment }) => experiment))
        .map((e) => e.reduce((aggregator, entry) => {
          Object.entries(entry).forEach(([key, value]) => {
            if (!aggregator[key]) {
              aggregator[key] = value;
            } else if (aggregator[key] !== value) {
              if (/(splits?|urls?|variants?)/.test(key)) {
                aggregator[key] = [].concat(aggregator[key], value);
              } else {
                // eslint-disable-next-line no-console
                console.warn(`Key "${key}" in the experiment manifest must be the same for every variant.`);
              }
            }
          });
          return aggregator;
        }, {}));
    }
    watchMutationsAndApplyFragments(ns, document.body, entries, fragmentsNS, pluginOptions, metadataToConfig, getAllQueryParameters(paramNS), cb);
  }

  return { page: pageNS, sections: sectionsNS, fragments: fragmentsNS };
}

async function getExperimentConfig(pluginOptions, metadata, overrides) {
  const id = toClassName(metadata.value || metadata.experiment);
  if (!id) {
    return null;
  }

  let pages = metadata.variants || metadata.url;

  // Backward compatibility
  if (!pages) {
    pages = getMetadata('instant-experiment');
  }
  if (metadata.audience) {
    metadata.audiences = metadata.audience;
  }

  const nbOfVariants = Number(pages);
  pages = Number.isNaN(nbOfVariants)
    ? stringToArray(pages).map((p) => new URL(p.trim(), window.location).pathname)
    : new Array(nbOfVariants).fill(window.location.pathname);
  if (!pages.length) {
    return null;
  }

  const audiences = stringToArray(metadata.audiences).map(toClassName);

  const splits = metadata.split
    // custom split
    ? stringToArray(metadata.split).map((i) => parseInt(i, 10) / 100)
    // even split
    : [...new Array(pages.length)].map(() => 1 / (pages.length + 1));

  const variantNames = [];
  variantNames.push('control');

  const variants = {};
  variants.control = {
    percentageSplit: '',
    pages: [window.location.pathname],
    label: 'Control',
  };

  pages.forEach((page, i) => {
    const vname = `challenger-${i + 1}`;
    variantNames.push(vname);
    variants[vname] = {
      percentageSplit: `${splits[i].toFixed(2)}`,
      pages: [page],
      blocks: [],
      label: `Challenger ${i + 1}`,
    };
  });
  inferEmptyPercentageSplits(Object.values(variants));

  const resolvedAudiences = await getResolvedAudiences(
    audiences,
    pluginOptions,
  );

  const startDate = metadata.startDate ? new Date(metadata.startDate) : null;
  const endDate = metadata.endDate ? new Date(metadata.endDate) : null;

  const config = {
    id,
    label: metadata.name || `Experiment ${metadata.value || metadata.experiment}`,
    status: metadata.status || 'active',
    audiences,
    endDate,
    resolvedAudiences,
    startDate,
    variants,
    variantNames,
  };

  config.run = (
    // experiment is active or forced
    (['active', 'on', 'true'].includes(toClassName(config.status)) || overrides.experiment)
    // experiment has resolved audiences if configured
    && (!resolvedAudiences || resolvedAudiences.length)
    // forced audience resolves if defined
    && (!overrides.audience || audiences.includes(overrides.audience))
    && (!startDate || startDate <= Date.now())
    && (!endDate || endDate > Date.now())
  );

  if (!config.run) {
    return config;
  }

  const [, forcedVariant] = (Array.isArray(overrides.value)
    ? overrides.value
    : stringToArray(overrides.value))
    .map((value) => value?.split('/'))
    .find(([experiment]) => toClassName(experiment) === config.id) || [];
  if (variantNames.includes(toClassName(forcedVariant))) {
    config.selectedVariant = toClassName(forcedVariant);
  } else if (overrides.variant && variantNames.includes(overrides.variant)) {
    config.selectedVariant = toClassName(overrides.variant);
  } else {
    // eslint-disable-next-line import/extensions
    const { ued } = await import('./ued.js');
    const decision = ued.evaluateDecisionPolicy(toDecisionPolicy(config), {});
    config.selectedVariant = decision.items[0].id;
  }

  return config;
}

function getUrlFromExperimentConfig(config) {
  return config.run
    ? config.variants[config.selectedVariant].pages[0]
    : null;
}

async function runExperiment(document, pluginOptions) {
  return applyAllModifications(
    pluginOptions.experimentsMetaTag,
    pluginOptions.experimentsQueryParameter,
    pluginOptions,
    getExperimentConfig,
    getUrlFromExperimentConfig,
    (el, config, result) => {
      const { id, selectedVariant, variantNames } = config;
      el.classList.add(`experiment-${toClassName(id)}`);
      el.classList.add(`variant-${toClassName(result ? selectedVariant : variantNames[0])}`);
      if (pluginOptions.trackingFunction) {
        pluginOptions.trackingFunction('experiment', {
          source: id,
          target: result ? selectedVariant : variantNames[0],
        });
      }
      pluginOptions.decorateFuntion(el);
    },
  );
}

async function getCampaignConfig(pluginOptions, metadata, overrides) {
  if (!Object.keys(metadata).length) {
    return null;
  }

  // Check UTM parameters
  let campaign = overrides.value;
  if (!campaign) {
    const usp = new URLSearchParams(window.location.search);
    if (usp.has('utm_campaign')) {
      campaign = toClassName(usp.get('utm_campaign'));
    }
  } else {
    campaign = toClassName(campaign);
  }

  if (metadata.audience) {
    metadata.audiences = metadata.audience;
  }

  const audiences = stringToArray(metadata.audiences).map(toClassName);
  const resolvedAudiences = await getResolvedAudiences(
    audiences,
    pluginOptions,
  );
  if (resolvedAudiences && !resolvedAudiences.length) {
    return null;
  }

  const configuredCampaigns = Object.fromEntries(Object.entries(metadata)
    .filter(([key]) => !['audience', 'audiences'].includes(key)));

  return {
    audiences,
    configuredCampaigns,
    resolvedAudiences,
    selectedCampaign: campaign && metadata[campaign]
      ? campaign
      : null,
  };
}

function getUrlFromCampaignConfig(config) {
  return config.selectedCampaign
    ? config.configuredCampaigns[config.selectedCampaign]
    : null;
}

async function runCampaign(document, options) {
  const pluginOptions = { ...DEFAULT_OPTIONS, ...(options || {}) };
  return applyAllModifications(
    pluginOptions.campaignsMetaTagPrefix,
    pluginOptions.campaignsQueryParameter,
    pluginOptions,
    getCampaignConfig,
    getUrlFromCampaignConfig,
    (el, config, result) => {
      const { selectedAudience = 'default' } = config;
      el.classList.add(`campaign-${toClassName(selectedAudience)}`);
      if (pluginOptions.trackingFunction) {
        pluginOptions.trackingFunction('campaign', {
          source: el.className,
          target: result ? selectedAudience : 'default',
        });
      }
    },
  );
}

async function getAudienceConfig(pluginOptions, metadata, overrides) {
  if (!Object.keys(metadata).length) {
    return null;
  }

  const configuredAudiencesName = Object.keys(metadata).map(toClassName);
  const resolvedAudiences = await getResolvedAudiences(
    configuredAudiencesName,
    pluginOptions,
  );
  if (resolvedAudiences && !resolvedAudiences.length) {
    return false;
  }

  const selectedAudience = overrides.audience || resolvedAudiences[0];

  return {
    configuredAudiences: metadata,
    resolvedAudiences,
    selectedAudience,
  };
}

function getUrlFromAudienceConfig(config) {
  return config.selectedAudience
    ? config.configuredAudiences[config.selectedAudience]
    : null;
}

async function serveAudience(document, options) {
  const pluginOptions = { ...DEFAULT_OPTIONS, ...(options || {}) };
  return applyAllModifications(
    pluginOptions.audiencesMetaTagPrefix,
    pluginOptions.audiencesQueryParameter,
    pluginOptions,
    getAudienceConfig,
    getUrlFromAudienceConfig,
    (el, config, result) => {
      const { selectedAudience = 'default' } = config;
      el.classList.add(`audience-${toClassName(selectedAudience)}`);
      if (pluginOptions.trackingFunction) {
        pluginOptions.trackingFunction('audience', {
          source: el.className,
          target: result ? selectedAudience : 'default',
        });
      }
    },
  );
}

export async function loadEager(document, options = {}) {
  const pluginOptions = { ...DEFAULT_OPTIONS, ...options };
  setDebugMode(pluginOptions);

  const ns = window.aem || window.hlx || {};
  ns.audiences = await serveAudience(document, pluginOptions);
  ns.experiments = await runExperiment(document, pluginOptions);
  ns.campaigns = await runCampaign(document, pluginOptions);

  // Backward compatibility
  ns.experiment = ns.experiments?.page?.config
    ? {
      ...ns.experiments.page.config,
      ...(ns.experiments.page.servedExperience
        ? { servedExperience: ns.experiments.page.servedExperience }
        : {}),
    }
    : null;
  ns.audience = ns.audiences?.page?.config
    ? {
      audiences: ns.audiences.page.config.configuredAudiences,
      selectedAudience: ns.audiences.page.config.serveAudience,
      ...(ns.audiences.page.servedExperience
        ? { servedExperience: ns.audiences.page.servedExperience }
        : {}),
    }
    : null;
}

export async function loadLazy(document, options = {}) {
  const pluginOptions = { ...DEFAULT_OPTIONS, ...options };
  // do not show the experimentation pill on prod domains
  if (!isDebugEnabled) {
    return;
  }
  // eslint-disable-next-line import/no-cycle
  const preview = await import('./preview.js');
  preview.default(document, pluginOptions);
}

// let isAdjusted = false;
// function adjustedRumSamplingRate(checkpoint, options, context) {
//   const pluginOptions = { ...DEFAULT_OPTIONS, ...(options || {}) };
//   return (data) => {
//     if (!window.hlx.rum.isSelected && !isAdjusted) {
//       isAdjusted = true;
//       // adjust sampling rate based on project config …
//       window.hlx.rum.weight = Math.min(
//         window.hlx.rum.weight,
//         // … but limit it to the 10% sampling at max to avoid losing anonymization
//         // and reduce burden on the backend
//         Math.max(pluginOptions.rumSamplingRate, MAX_SAMPLING_RATE),
//       );
//       window.hlx.rum.isSelected = (window.hlx.rum.random * window.hlx.rum.weight < 1);
//       if (window.hlx.rum.isSelected) {
//         context.sampleRUM(checkpoint, data);
//       }
//     }
//     return true;
//   };
// }

// export async function loadEager(document, options, context) {
//   context.sampleRUM.always.on('audiences', adjustedRumSamplingRate('audiences', options, context));
//   context.sampleRUM.always.on('campaign', adjustedRumSamplingRate('campaign', options, context));
//   context.sampleRUM.always.on('experiment', adjustedRumSamplingRate('experiment', options, context));
//   let res = await runCampaign(document, options, context);
//   if (!res) {
//     res = await runExperiment(document, options, context);
//   }
//   if (!res) {
//     res = await serveAudience(document, options, context);
//   }
// }
