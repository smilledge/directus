import { defineStore } from 'pinia';

export const useAppStore = defineStore({
	id: 'appStore',
	state: () => ({
		sidebarOpen: false,
		fullScreen: false,
		hydrated: false,
		hydrating: false,
		error: null,
		authenticated: false,
		basemap: 'OpenStreetMap',
	}),
});
