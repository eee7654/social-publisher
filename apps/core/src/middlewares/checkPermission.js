import { ErrorCodes } from "@/constants/responseCodes";
import { AppError } from "@/lib/AppError";
import { ForbiddenError } from "@casl/ability";

/**
 * 
 * @param {String} action
 * @param {String} subject
 */
export const checkPermission = (action, subject) => {
    return async(req, res, next) => {
        if (!req.ability) throw new AppError(500, ErrorCodes.GEN_INTERNAL_ERROR, false);
        ForbiddenError.from(req.ability).throwUnlessCan(action, subject);
        await next();
    };
};