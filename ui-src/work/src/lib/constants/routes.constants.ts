/** Query params the chat routes read from the URL. */
export const URL_PARAMS = {
	/** Load the selected model instead of waiting for the first message. */
	LOAD: 'load',
	/** Model to select. */
	MODEL: 'model',
	/** Prompt to send on arrival. */
	QUERY: 'q'
} as const;

export const ROUTES = {
	/** Chat base — for dynamic chat URLs use RouterService. */
	CHAT: '#/chat',
	/** Search — mobile-only full-page conversation search. */
	SEARCH: '#/search',
	/** Performance monitoring dashboard. */
	PERFORMANCE: '#/performance',
	/** Parameter panel — launch presets + launch/sampling parameters. */
	PARAMETERS: '#/parameters',
	/** Settings — full-page form (same shell as Performance / Parameters). */
	SETTINGS: '#/settings',
	/** Root — start of the app. */
	START: '#/'
} as const;
