/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Configuration } from "@atomist/automation-client";
import {
    any,
    AnyPush,
    ArtifactGoal,
    goalContributors,
    Goals,
    JustBuildGoal,
    LocalDeploymentGoal,
    not,
    onAnyPush,
    ProductionDeploymentGoal,
    ProductionEndpointGoal,
    ProductionUndeploymentGoal,
    PushReactionGoal,
    ReviewGoal,
    SoftwareDeliveryMachine,
    StagingDeploymentGoal,
    StagingEndpointGoal,
    StagingVerifiedGoal,
    ToDefaultBranch,
    whenPushSatisfies,
} from "@atomist/sdm";
import * as build from "@atomist/sdm/dsl/buildDsl";
import * as deploy from "@atomist/sdm/dsl/deployDsl";
import { StagingUndeploymentGoal } from "@atomist/sdm/goal/common/commonGoals";
import { RepositoryDeletionGoals, UndeployEverywhereGoals } from "@atomist/sdm/goal/common/httpServiceGoals";
import { isDeployEnabledCommand } from "@atomist/sdm/handlers/commands/DisplayDeployEnablement";
import { disableDeploy, enableDeploy } from "@atomist/sdm/handlers/commands/SetDeployEnablement";
import { MavenBuilder } from "@atomist/sdm/internal/delivery/build/local/maven/MavenBuilder";
import { ManagedDeploymentTargeter } from "@atomist/sdm/internal/delivery/deploy/local/ManagedDeployments";
import { createEphemeralProgressLog } from "@atomist/sdm/log/EphemeralProgressLog";
import { ConcreteSoftwareDeliveryMachineOptions } from "@atomist/sdm/machine/ConcreteSoftwareDeliveryMachineOptions";
import { createSoftwareDeliveryMachine } from "@atomist/sdm/machine/machineFactory";
import { IsMaven } from "@atomist/sdm/mapping/pushtest/jvm/jvmPushTests";
import {IsNode} from "@atomist/sdm/mapping/pushtest/node/nodePushTests";
import { HasCloudFoundryManifest } from "@atomist/sdm/mapping/pushtest/pcf/cloudFoundryManifestPushTest";
import {
    deploymentFreeze,
    ExplainDeploymentFreezeGoal,
    isDeploymentFrozen,
} from "@atomist/sdm/pack/freeze/deploymentFreeze";
import { InMemoryDeploymentStatusManager } from "@atomist/sdm/pack/freeze/InMemoryDeploymentStatusManager";
import { lookFor200OnEndpointRootGet } from "@atomist/sdm/util/verify/lookFor200OnEndpointRootGet";
import {
    cloudFoundryProductionDeploySpec,
    EnableDeployOnCloudFoundryManifestAddition,
} from "../blueprint/deploy/cloudFoundryDeploy";
import { LocalExecutableJarDeployer } from "../blueprint/deploy/localSpringBootDeployers";
import { SuggestAddingCloudFoundryManifest } from "../blueprint/repo/suggestAddingCloudFoundryManifest";
import { addCloudFoundryManifest } from "../commands/editors/pcf/addCloudFoundryManifest";
import { CloudReadinessChecks } from "../pack/cloud-readiness/cloudReadiness";
import { NodeSupport } from "../pack/node/nodeSupport";
import { SentrySupport } from "../pack/sentry/sentrySupport";
import { HasSpringBootApplicationClass } from "../pack/spring/pushtest/springPushTests";
import { SpringSupport } from "../pack/spring/springSupport";
import { addDemoEditors } from "../parts/demo/demoEditors";
import { addJavaSupport } from "../parts/stacks/javaSupport";
import { addTeamPolicies } from "../parts/team/teamPolicies";

const freezeStore = new InMemoryDeploymentStatusManager();

const IsDeploymentFrozen = isDeploymentFrozen(freezeStore);

/**
 * Variant of cloudFoundryMachine that uses additive, "contributor" style goal setting.
 * @return {SoftwareDeliveryMachine}
 */
export function additiveCloudFoundryMachine(options: ConcreteSoftwareDeliveryMachineOptions,
                                            configuration: Configuration): SoftwareDeliveryMachine {
    const sdm = createSoftwareDeliveryMachine(
        {
            name: "CloudFoundry software delivery machine",
            options, configuration,
        },
        // Each contributor contributes goals. The infrastructure assembles them into a goal set.
        goalContributors(
            onAnyPush.setGoals(new Goals("Checks", ReviewGoal, PushReactionGoal)),
            whenPushSatisfies(IsDeploymentFrozen)
                .setGoals(ExplainDeploymentFreezeGoal),
            whenPushSatisfies(any(IsMaven, IsNode))
                .setGoals(JustBuildGoal),
            whenPushSatisfies(HasSpringBootApplicationClass, not(ToDefaultBranch))
                .setGoals(LocalDeploymentGoal),
            whenPushSatisfies(HasCloudFoundryManifest, ToDefaultBranch)
                .setGoals([ArtifactGoal,
                    StagingDeploymentGoal,
                    StagingEndpointGoal,
                    StagingVerifiedGoal]),
            whenPushSatisfies(HasCloudFoundryManifest, not(IsDeploymentFrozen), ToDefaultBranch)
                .setGoals([ArtifactGoal,
                    ProductionDeploymentGoal,
                    ProductionEndpointGoal]),
        ));

    sdm.addPushReactions(async p => {
        const readme = await p.project.getFile("README.md");
        if (!readme) {
            return p.addressChannels(`Project at ${p.id.url} has no README. This makes me sad. :crying_cat_face:`);
        }
    })
        .addNewIssueListeners(async i => {
            return i.addressChannels(`_${i.issue.openedBy.person.chatId.screenName}_, *stop* raising issues. :angry:`);
        });

    sdm.addExtensionPacks(
        deploymentFreeze(freezeStore),
        SpringSupport,
        SentrySupport,
        CloudReadinessChecks,
        NodeSupport,
    );

    sdm.addDeployRules(
        deploy.when(IsMaven)
            .deployTo(StagingDeploymentGoal, StagingEndpointGoal, StagingUndeploymentGoal)
            .using(
                {
                    deployer: LocalExecutableJarDeployer,
                    targeter: ManagedDeploymentTargeter,
                },
            ),
        deploy.when(IsMaven)
            .deployTo(ProductionDeploymentGoal, ProductionEndpointGoal, ProductionUndeploymentGoal)
            .using(cloudFoundryProductionDeploySpec(options)),
    );
    sdm.addDisposalRules(
        whenPushSatisfies(IsMaven, HasSpringBootApplicationClass, HasCloudFoundryManifest)
            .itMeans("Java project to undeploy from PCF")
            .setGoals(UndeployEverywhereGoals),
        whenPushSatisfies(AnyPush)
            .itMeans("We can always delete the repo")
            .setGoals(RepositoryDeletionGoals));
    sdm.addChannelLinkListeners(SuggestAddingCloudFoundryManifest)
        .addSupportingCommands(
            () => addCloudFoundryManifest,
            enableDeploy,
            disableDeploy,
            isDeployEnabledCommand,
        )
        .addPushReactions(EnableDeployOnCloudFoundryManifestAddition)
        .addEndpointVerificationListeners(lookFor200OnEndpointRootGet());
    addJavaSupport(sdm);
    addTeamPolicies(sdm);
    addDemoEditors(sdm);
    // addDemoPolicies(sdm, configuration);

    sdm.addBuildRules(
        build.setDefault(new MavenBuilder(options.artifactStore,
            createEphemeralProgressLog, options.projectLoader)));

    return sdm;
}
