export {};
declare global { interface Window { archsyncDesktop?: {chooseFolder: () => Promise<string | null>}; } }
