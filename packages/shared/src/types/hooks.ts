import { ApiExtensionContext } from './extensions';

type FilterHandler = (data?: Record<string, any>) => any | Promise<any>;
type ActionHandler = (data?: Record<string, any>) => void | Promise<void>;
type InitHandler = (data?: Record<string, any>) => void | Promise<void>;
type ScheduleHandler = () => void | Promise<void>;

type RegisterFunctions = {
	filter: (event: string, handler: FilterHandler) => void;
	action: (event: string, handler: ActionHandler) => void;
	init: (event: string, handler: InitHandler) => void;
	schedule: (cron: string, handler: ScheduleHandler) => void;
};

type HookHandlerFunction = (register: RegisterFunctions, context: ApiExtensionContext) => void;

export type HookConfig = HookHandlerFunction;
