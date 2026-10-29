/*eslint-disable*/
var path = require("path")
var webpack = require("webpack")

const paths = require('react-scripts/config/paths')
paths.appBuild = path.join(__dirname, '../ui/typedown')

module.exports = function override(config, env) {
    const oneOfRule = config.module.rules.find(rule => Array.isArray(rule.oneOf))
    if (oneOfRule) {
        oneOfRule.oneOf.unshift({
            test: /\.(woff2?|ttf|otf|eot)$/i,
            type: 'asset/inline'
        })
    }

    const htmlPlugin = config.plugins.find(plugin => plugin.constructor && plugin.constructor.name === 'HtmlWebpackPlugin')
    if (htmlPlugin) {
        if (htmlPlugin.userOptions) htmlPlugin.userOptions.inject = 'body'
        else if (htmlPlugin.options) htmlPlugin.options.inject = 'body'
    }

    const overrideConfig = {
        ...config,
        module: {
            ...config.module,
            rules: [
                ...config.module.rules,
                {
                    test: require.resolve(path.join(__dirname, './src/assets/libs/snap.svg-min.js')),
                    use: 'imports-loader?this=>window,fix=>module.exports=0'
                }
            ]
        },
        resolve: {
            ...config.resolve,
            alias: {
                ...config.resolve.alias,
                snapsvg: path.join(__dirname, './src/assets/libs/snap.svg-min.js')
            },
        },
        plugins: [
            ...config.plugins,
            new webpack.optimize.LimitChunkCountPlugin({
                maxChunks: 1
            }),
            new webpack.ProvidePlugin({
                process: 'process/browser',
            }),
        ]
    }

    return overrideConfig;
}
