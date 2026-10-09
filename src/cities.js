// Pinned BOSS city-selector facts. No account/session data or runtime API calls.
import cityCatalog from './city-catalog.json' with { type:'json' };
export const CITY_GROUPS = Object.freeze(cityCatalog.cityGroups.map(group=>Object.freeze({label:group.label,options:Object.freeze(group.options.map(option=>Object.freeze({...option})))})));
export const CITY_CODES = Object.freeze(Object.fromEntries(CITY_GROUPS.flatMap(group=>group.options).map(option=>[option.name,option.code])));
export const CITY_SOURCE = Object.freeze(Object.fromEntries(Object.entries(cityCatalog).filter(([key])=>!['cityGroups','nationwide'].includes(key))));
