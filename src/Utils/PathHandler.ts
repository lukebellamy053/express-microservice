import {EnvironmentVariables, ErrorResponses, Method} from '../Enums';
import {Express, Request, Response} from 'express';
import {RouteItem} from '../Classes';
import {HTTPControllerInterface, RouteInterface} from '../Interfaces';
import {Controller} from '../Server';
import {Passport} from '../Security';
import {env} from '../Environment/EnvironmentConfig';
import {DecoratorUtils} from '../Decorators/DecoratorUtils';

/**
 * A class to handle the registration of routes
 */
export class PathHandler {
    // The registered controllers
    protected mControllers: { [x: string]: Controller } = {};
    // The Express application
    protected mApp: () => Express;
    // The active path handler instance
    protected static mPathHandler: PathHandler;

    /**
     * Get the active path handler instance
     */
    public static get pathHandler(): PathHandler {
        if (!PathHandler.mPathHandler) {
            PathHandler.mPathHandler = new PathHandler();
        }
        return PathHandler.mPathHandler;
    }

    /**
     * Set the active path handler instance
     * @param handler
     */
    public static set pathHandler(handler: PathHandler) {
        // Pass on the app object if found
        const _app = this.pathHandler.app;
        if (_app) {
            handler.app = _app;
        }
        // Set the new path handler
        PathHandler.mPathHandler = handler;
    }

    /**
     * Get the server app
     * @returns {e.Express}
     */
    public get app(): Express {
        return this.mApp();
    }

    /**
     * Set the path handler app
     * @param _app
     */
    public set app(_app: Express) {
        this.mApp = () => {
            // This is one of those javascript things, if you set the value directly, it will be undefined
            return _app;
        };
    }

    /**
     * Add a new controller item
     * @param controllerItems - Object or array of controllers
     */
    public addController(controllerItems: any[] | { [x: string]: Controller }) {
        let newControllers = controllerItems;
        if (Array.isArray(controllerItems)) {
            // Work out the controller object automatically
            newControllers = {};
            controllerItems.forEach(item => {
                newControllers[(<any>item).prototype.constructor.name] = item;
            });
        }
        this.mControllers = Object.assign(this.mControllers, newControllers);
    }

    /**
     * Combine the route auth handler to the class auth handler if required
     * @param route
     * @param prePath
     */
    protected checkRouteHandlers(route: RouteItem, prePath: HTTPControllerInterface): RouteItem | undefined {
        const existingAuthHandler = route.authHandler;
        /**
         * Create the new authentication handler
         * @param controller - The active controller
         */
        const newHandler = makeNewHandler(prePath, existingAuthHandler);

        // Add the controller path to the start of the path
        route = new RouteItem(
            `${prePath.path || ''}${route.path}`,
            route.handler,
            route.method,
            prePath.protected || route.protected,
            newHandler,
            route.priority,
        );
        return route;
    }

    /**
     * Perform some checks before registering the route
     * @param route
     */
    protected preRegisterRoute(route: RouteItem) {
        const controllerName = route.handler.split('@')[0];
        if (!controllerName) {
            // This should not happen
            return undefined;
        }
        // Check if the controller has been registered already
        const prePath = DecoratorUtils.controllerPaths[controllerName];
        if (prePath) {
            // Convert the routes auth handler to include the class handler
            const newRoute: RouteItem | undefined = this.checkRouteHandlers(route, prePath);
            if (newRoute) {
                // Add the route if its still valid
                this.register(newRoute);
            }
        } else {
            this.register(route);
        }
    }

    /**
     * Register the default paths
     */
    public registerDefaults() {
        /**
         * Sort the routes by their priorities
         */
        DecoratorUtils.pending.sort((pathA, pathB) => {
            if (pathA.priority < pathB.priority) return 1;
            if (pathA.priority > pathB.priority) return -1;
            return 0;
        });

        DecoratorUtils.pending.forEach((route: RouteItem) => {
            this.preRegisterRoute(route);
        });
    }

    /**
     * Register an array of routes
     * @param {RouteInterface[]} routes
     */
    public registerRouteArray(routes: RouteInterface[]) {
        routes.forEach((route: RouteInterface) => {
            const routeItem = new RouteItem(
                route.path,
                route.handler,
                route.method,
                route.protected,
                route.authenticationHandler,
                route.priority,
            );
            this.register(routeItem);
        });
    }

    /**
     * The default request handler
     * Checks the request is valid before forwarding it to the correct controller
     * @param route
     */
    protected defaultHandler = (route: RouteItem) => {
        return async (req: Request, res: Response) => {
            /**
             * Check if the route is protected by the generic authenticator
             */
            if (route.protected) {
                // Use the custom verifier or the generic verifier
                try {
                    await Passport.passport.verifyRequest(req);
                } catch (exception) {
                    PathHandler.fail(res, exception);
                    return;
                }
            }

            try {
                // Call the method
                this.callHandler(route, req, res);
            } catch (exception) {
                PathHandler.fail(res, exception);
            }
        };
    };

    /**
     * Register a http route handler
     * @param {RouteInterface} route
     */
    public register(route: RouteItem): void {
        /**
         * The method that will handle the incoming request
         * @param req
         * @param res
         */
        const handler = this.defaultHandler(route);

        switch (route.method) {
            case Method.GET:
                this.app.get(route.path, handler);
                break;
            case Method.DELETE:
                this.app.delete(route.path, handler);
                break;
            case Method.OPTIONS:
                this.app.options(route.path, handler);
                break;
            case Method.POST:
                this.app.post(route.path, handler);
                break;
            case Method.PUT:
                this.app.put(route.path, handler);
                break;
            default:
                this.app.all(route.path, handler);
        }

        // Register the routes authentication handler if one exists
        Passport.addGatedMethod(route.handler, route.authHandler);
    }

    /**
     * Call the handler for a route
     * @param {RouteItem} route
     * @param request
     * @param response
     */
    protected callHandler(route: RouteItem, request: Request, response: Response) {
        if (this.mControllers[route.handlerClass]) {
            new (<any>this.mControllers[route.handlerClass])(request, response, route.handlerMethod);
        } else {
            throw ErrorResponses.InvalidRoute;
        }
    }

    /**
     * Register a route to use a proxy
     * @param {string} path
     * @param proxy
     * @param removePath
     * @param {boolean} isProtected
     * @param authHandler
     * @param jwtVerify
     */
    public registerProxy(
        path: string,
        proxy: any,
        removePath: string,
        isProtected?: boolean,
        authHandler?: any,
        jwtVerify: boolean = false,
    ) {
        const postAuth = (req: Request, res: Response) => {
            if (removePath != null) {
                if(req.method == 'GET') {
                    delete req.body;
                }
                req.url = req.url.replace(removePath, '');
            }
            proxy(req, res);
        };

        this.app.all(path, async (req: Request, res) => {
            if (isProtected) {
                try {
                    await Passport.passport.verifyRequest(req);
                    if (authHandler) {
                        await authHandler(req);
                    }
                } catch (exception) {
                    PathHandler.fail(res, exception);
                    return;
                }
            }

            try {
                postAuth(req, res);
            } catch (exception) {
                PathHandler.fail(res, exception);
            }
        });
    }

    /**
     * Send a failed request message
     * @param req
     * @param {string} reason
     * @param code
     */
    protected static fail(req: Response, reason: string, code: number = 200) {
        req.status(code).json({
            success: false,
            version: env(EnvironmentVariables.APP_VERSION),
            build: env(EnvironmentVariables.APP_BUILD),
            service: env(EnvironmentVariables.SERVICE_NAME),
            error: reason.toString(),
        });
    }
}

/**
 * Creates the new joined auth handler
 * @param prePath
 * @param existingAuthHandler
 */
function makeNewHandler(prePath: HTTPControllerInterface, existingAuthHandler: any) {
    return async (controller: Controller) => {
        let res = true;
        // Call the controllers auth handler
        if (prePath.authenticationHandler) {
            res = await prePath.authenticationHandler(controller);
        }

        if (res && existingAuthHandler) {
            res = await existingAuthHandler(controller);
        }

        return res;
    };
}
