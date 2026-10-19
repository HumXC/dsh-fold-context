import { Context, Service, type Volatile } from "@deepseek-ai/cordis";
import { resolveSummaryModels, type SummaryModel } from "../domain/summary-models.js";
import { normalizePolicyOverrides, type PolicyOverrides } from "../domain/settings-catalog.js";

declare module "@deepseek-ai/cordis" {
    interface Context {
        foldContextSettings: FoldContextSettings;
    }
}
/** One profile owner, shared by preset-scoped engines without recomposing Agents. */
export class FoldContextSettings extends Service {
    constructor(
        ctx: Context,
        private readonly models: Volatile<SummaryModel[]>,
        private readonly overrides?: Volatile<PolicyOverrides>,
    ) {
        super(ctx, "foldContextSettings");
        this.current();
        this.policies();
    }
    current(): SummaryModel[] {
        return resolveSummaryModels(this.models.get());
    }
    policies(): PolicyOverrides {
        return normalizePolicyOverrides(this.overrides?.get());
    }
}
